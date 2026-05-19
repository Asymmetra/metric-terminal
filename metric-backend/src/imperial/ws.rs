//! Imperial WebSocket client — /ws/market public market-data stream.
//!
//! Connects upstream once, subscribes to funding_rates / mark_prices /
//! phoenix_depth, and emits typed events. Auto-reconnects with backoff.
//! Per-wallet /ws subscriptions are not modeled here; the frontend talks
//! to /ws directly for those (it's just a refetch-trigger ping).

use crate::imperial::error::ImperialError;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Wire format for /ws/market events.
///
/// Imperial's WS uses snake_case keys even though the OpenAPI REST docs
/// show camelCase for the equivalent shapes — verified empirically (the
/// initial camelCase renames decoded successfully but yielded all-None
/// rate fields, and the required `fetched_at_unix_ms` produced a hard
/// decode error). We match the actual wire format here and let the
/// relay rename to camelCase for downstream broadcasts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MarketEvent {
    #[serde(rename = "funding_rate_update")]
    FundingRateUpdate {
        symbol: String,
        venue: String,
        source: String,
        long_funding_rate_per_hour_percent: Option<f64>,
        short_funding_rate_per_hour_percent: Option<f64>,
        long_borrow_rate_per_hour_percent: Option<f64>,
        short_borrow_rate_per_hour_percent: Option<f64>,
    },
    #[serde(rename = "mark_price_update")]
    MarkPriceUpdate {
        symbol: String,
        venue: String,
        source: String,
        price: f64,
        fetched_at_unix_ms: i64,
    },
    #[serde(rename = "phoenix_depth_update")]
    PhoenixDepthUpdate {
        symbol: String,
        snapshot: serde_json::Value,
    },
    /// Catch-all for ping/pong and anything Imperial adds later.
    #[serde(other)]
    Other,
}

pub struct ImperialMarketWs {
    url: String,
    /// What we want subscribed once we (re)connect.
    sub_funding: bool,
    sub_mark: bool,
    /// None = none; Some(empty) = all symbols; Some(non-empty) = filtered.
    sub_phoenix_depth: Option<Vec<String>>,
}

impl ImperialMarketWs {
    pub fn from_env() -> Self {
        // Imperial WS endpoints live at the root (/ws and /ws/market), not
        // under /api/v1. See the openapi description block.
        let base = std::env::var("IMPERIAL_WS_URL")
            .unwrap_or_else(|_| "wss://api.imperial.space".to_string())
            .trim_end_matches('/')
            .to_string();
        Self {
            url: format!("{}/ws/market", base),
            sub_funding: true,
            sub_mark: true,
            sub_phoenix_depth: Some(vec![]),
        }
    }

    /// Spawn a forever-reconnecting task that emits events on the channel.
    /// Returns the receive half; the send half lives in the spawned task.
    pub fn spawn(self) -> mpsc::UnboundedReceiver<MarketEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move { self.run(tx).await });
        rx
    }

    async fn run(mut self, tx: mpsc::UnboundedSender<MarketEvent>) {
        let mut backoff = Duration::from_millis(500);
        loop {
            match self.connect_and_pump(&tx).await {
                Ok(()) => {
                    tracing::warn!("imperial /ws/market closed cleanly; reconnecting");
                    backoff = Duration::from_millis(500);
                }
                Err(e) => {
                    tracing::warn!("imperial /ws/market error: {:?}; reconnecting in {:?}", e, backoff);
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
            // If the receiver dropped, exit.
            if tx.is_closed() {
                return;
            }
        }
    }

    async fn connect_and_pump(
        &mut self,
        tx: &mpsc::UnboundedSender<MarketEvent>,
    ) -> Result<(), ImperialError> {
        tracing::info!("connecting upstream WS: {}", self.url);
        let (ws, _) = tokio_tungstenite::connect_async(&self.url)
            .await
            .map_err(|e| ImperialError::Ws(format!("connect: {e}")))?;
        let (mut writer, mut reader) = ws.split();

        if self.sub_funding {
            writer
                .send(Message::Text(r#"{"type":"subscribe_funding_rates"}"#.into()))
                .await
                .map_err(|e| ImperialError::Ws(e.to_string()))?;
        }
        if self.sub_mark {
            writer
                .send(Message::Text(r#"{"type":"subscribe_mark_prices"}"#.into()))
                .await
                .map_err(|e| ImperialError::Ws(e.to_string()))?;
        }
        if let Some(syms) = &self.sub_phoenix_depth {
            let payload = if syms.is_empty() {
                r#"{"type":"subscribe_phoenix_depth"}"#.to_string()
            } else {
                serde_json::json!({
                    "type": "subscribe_phoenix_depth",
                    "symbols": syms
                })
                .to_string()
            };
            writer
                .send(Message::Text(payload))
                .await
                .map_err(|e| ImperialError::Ws(e.to_string()))?;
        }

        // App-level ping every 25s keeps the connection alive across some
        // intermediaries that close idle sockets.
        let ping_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(25));
            interval.tick().await;
            loop {
                interval.tick().await;
                if writer
                    .send(Message::Text(r#"{"type":"ping"}"#.into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        while let Some(msg) = reader.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // Peek at the wire-level "type" tag so we notice if
                    // Imperial introduces an event variant we don't model.
                    if let Some(t) = peek_type(&text) {
                        tracing::trace!("ws event type={}", t);
                    }
                    match serde_json::from_str::<MarketEvent>(&text) {
                        Ok(ev) => {
                            if tx.send(ev).is_err() {
                                ping_handle.abort();
                                return Ok(());
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "ws decode failure: {} ({})",
                                e,
                                snippet(&text)
                            );
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {} // ignore binary / ping / pong frames
                Err(e) => {
                    ping_handle.abort();
                    return Err(ImperialError::Ws(e.to_string()));
                }
            }
        }
        ping_handle.abort();
        Ok(())
    }
}

fn snippet(s: &str) -> &str {
    let max = s.len().min(120);
    &s[..max]
}

fn peek_type(s: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    v.get("type")?.as_str().map(|s| s.to_string())
}
