use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures::stream::StreamExt;
use futures::SinkExt;
use std::sync::Arc;

use crate::state::AppState;
use crate::ws::messages::{ClientMessage, ServerMessage};

pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ServerMessage>();

    // Forward messages from mpsc channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if sender.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    // Process incoming messages from client
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                    match client_msg {
                        ClientMessage::Subscribe {
                            channel,
                            symbol,
                            authority,
                            ..
                        } => {
                            let key = if channel == "trader_margin" {
                                let pubkey = authority.as_deref().unwrap_or("unknown");
                                format!("trader_margin:{}", pubkey)
                            } else {
                                format!(
                                    "{}:{}",
                                    channel,
                                    symbol.as_deref().unwrap_or("*")
                                )
                            };
                            tracing::info!("Client subscribing to {}", key);

                            if channel == "trader_margin" {
                                let broadcast_rx =
                                    state.broadcast.subscribe_or_create(&key);
                                let tx_clone = tx.clone();
                                let mut sub_rx = broadcast_rx;

                                // Start trader relay via SDK if needed
                                if let Some(pubkey) = authority {
                                    let relay_ws = state.ws_client.clone();
                                    let relay_bcast = state.broadcast.clone();
                                    let relay_pubkey = pubkey.clone();
                                    tokio::spawn(async move {
                                        crate::ws::relay::start_trader_relay(
                                            relay_ws,
                                            relay_bcast,
                                            relay_pubkey,
                                        )
                                        .await;
                                    });
                                }

                                tokio::spawn(async move {
                                    while let Ok(msg) = sub_rx.recv().await {
                                        if tx_clone.send(msg).is_err() {
                                            break;
                                        }
                                    }
                                });
                            } else if let Some(broadcast_rx) =
                                state.broadcast.subscribe(&key)
                            {
                                let tx_clone = tx.clone();
                                let mut sub_rx = broadcast_rx;
                                tokio::spawn(async move {
                                    while let Ok(msg) = sub_rx.recv().await {
                                        if tx_clone.send(msg).is_err() {
                                            break;
                                        }
                                    }
                                });
                            }
                        }
                        ClientMessage::Unsubscribe { .. } => {
                            // Subscriptions are cleaned up when client disconnects
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();
}
