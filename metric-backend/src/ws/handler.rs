use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures::stream::StreamExt;
use futures::SinkExt;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinHandle;

use crate::state::AppState;
use crate::ws::messages::{ClientMessage, ServerMessage};

pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

fn channel_key(channel: &str, symbol: Option<&str>) -> String {
    format!("{}:{}", channel, symbol.unwrap_or("*"))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ServerMessage>();

    // Per-client forwarder handles. Aborted on Unsubscribe / disconnect so
    // broadcast subscriber counts drop deterministically.
    let mut forwarders: HashMap<String, JoinHandle<()>> = HashMap::new();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if sender.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                let parsed: Result<ClientMessage, _> = serde_json::from_str(&text);
                let Ok(client_msg) = parsed else { continue };
                match client_msg {
                    ClientMessage::Ping => {
                        let _ = tx.send(serde_json::json!({"type": "pong"}));
                    }
                    ClientMessage::Subscribe { channel, symbol } => {
                        let key = channel_key(&channel, symbol.as_deref());
                        if forwarders.contains_key(&key) {
                            continue;
                        }
                        tracing::info!("client subscribe {}", key);
                        let broadcast_rx = state.broadcast.subscribe_or_create(&key);
                        let tx_clone = tx.clone();
                        let mut sub_rx = broadcast_rx;
                        let handle = tokio::spawn(async move {
                            loop {
                                match sub_rx.recv().await {
                                    Ok(msg) => {
                                        if tx_clone.send(msg).is_err() {
                                            break;
                                        }
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                        tracing::warn!("ws forwarder lagged by {n}");
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                        break;
                                    }
                                }
                            }
                        });
                        forwarders.insert(key, handle);
                    }
                    ClientMessage::Unsubscribe { channel, symbol } => {
                        let key = channel_key(&channel, symbol.as_deref());
                        if let Some(h) = forwarders.remove(&key) {
                            h.abort();
                            tracing::info!("client unsubscribe {}", key);
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    for (_, h) in forwarders.drain() {
        h.abort();
    }
    send_task.abort();
}
