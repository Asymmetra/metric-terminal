use crate::phoenix::types::{OrderbookLevel, WsServerMessage};
use crate::services::broadcast::BroadcastHub;
use crate::services::market_cache::MarketCache;
use phoenix_sdk::{PhoenixWSClient, Timeframe};
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

/// Timeout (seconds) for relay receive loops. If no message arrives within this
/// window, assume the upstream subscription is dead and reconnect.
const RELAY_RECV_TIMEOUT_SECS: u64 = 120;

/// Start the relay that feeds data from Phoenix SDK WS into broadcast channels.
/// Subscribes to real orderbook, trades, stats, and candles for each market.
pub async fn start_relay(
    ws_client: Arc<PhoenixWSClient>,
    market_cache: Arc<MarketCache>,
    broadcast: Arc<BroadcastHub>,
    symbols: Vec<String>,
    known_traders: Option<Arc<dashmap::DashSet<String>>>,
) {
    for symbol in symbols {
        let ws = ws_client.clone();
        let cache = market_cache.clone();
        let bcast = broadcast.clone();
        let sym = symbol.clone();
        let traders = known_traders.clone();

        tokio::spawn(async move {
            if let Err(e) = start_market_relay(ws, cache, bcast, &sym, traders).await {
                tracing::error!("Failed to start relay for {}: {:?}", sym, e);
            }
        });
    }
}

/// Subscribe to all channels for a single market and forward to broadcast.
/// Each subscription runs in its own task with automatic reconnection on
/// upstream disconnection — if Phoenix WS drops, the relay self-heals.
async fn start_market_relay(
    ws_client: Arc<PhoenixWSClient>,
    cache: Arc<MarketCache>,
    broadcast: Arc<BroadcastHub>,
    symbol: &str,
    known_traders: Option<Arc<dashmap::DashSet<String>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::info!("Starting SDK WS relay for {}", symbol);

    // Orderbook relay with auto-reconnect
    {
        let ws = ws_client.clone();
        let bcast = broadcast.clone();
        let mcache = cache.clone();
        let sym = symbol.to_string();
        tokio::spawn(async move {
            let mut backoff_secs = 1u64;
            loop {
                let (mut rx, _handle) = match ws.subscribe_to_orderbook(sym.clone()) {
                    Ok(sub) => {
                        backoff_secs = 1;
                        tracing::info!("Orderbook subscription established for {}", sym);
                        sub
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to subscribe to orderbook for {}: {:?}, retrying in {}s",
                            sym, e, backoff_secs
                        );
                        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                        backoff_secs = (backoff_secs * 2).min(60);
                        continue;
                    }
                };
                loop {
                    match tokio::time::timeout(
                        Duration::from_secs(RELAY_RECV_TIMEOUT_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Some(update)) => {
                            let bids: Vec<OrderbookLevel> = update
                                .orderbook
                                .bids
                                .iter()
                                .map(|&(price, size)| OrderbookLevel { price, size })
                                .collect();
                            let asks: Vec<OrderbookLevel> = update
                                .orderbook
                                .asks
                                .iter()
                                .map(|&(price, size)| OrderbookLevel { price, size })
                                .collect();

                            mcache.update_orderbook(&sym, bids.clone(), asks.clone());
                            mcache.touch_relay("orderbook", &sym);

                            let msg = WsServerMessage {
                                channel: "orderbook".to_string(),
                                symbol: Some(sym.clone()),
                                data: serde_json::json!({
                                    "bids": bids,
                                    "asks": asks,
                                }),
                            };
                            bcast.send(&format!("orderbook:{}", sym), msg);
                        }
                        Ok(None) => break, // channel closed
                        Err(_) => {
                            tracing::warn!(
                                "Orderbook relay for {} timed out after {}s with no data — reconnecting",
                                sym, RELAY_RECV_TIMEOUT_SECS
                            );
                            break;
                        }
                    }
                }
                tracing::warn!(
                    "Orderbook subscription ended for {}, reconnecting in {}s",
                    sym, backoff_secs
                );
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        });
    }

    // Trades relay with auto-reconnect
    {
        let ws = ws_client.clone();
        let bcast = broadcast.clone();
        let cache = cache.clone();
        let sym = symbol.to_string();
        let known = known_traders.clone();
        tokio::spawn(async move {
            let mut backoff_secs = 1u64;
            loop {
                let (mut rx, _handle) = match ws.subscribe_to_trades(sym.clone()) {
                    Ok(sub) => {
                        backoff_secs = 1;
                        tracing::info!("Trades subscription established for {}", sym);
                        sub
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to subscribe to trades for {}: {:?}, retrying in {}s",
                            sym, e, backoff_secs
                        );
                        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                        backoff_secs = (backoff_secs * 2).min(60);
                        continue;
                    }
                };
                loop {
                    match tokio::time::timeout(
                        Duration::from_secs(RELAY_RECV_TIMEOUT_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Some(update)) => {
                            let trades: Vec<serde_json::Value> = update
                                .trades
                                .iter()
                                .map(|t| {
                                    if let Some(ref known) = known {
                                        if !t.taker.is_empty()
                                            && Pubkey::from_str(&t.taker).is_ok()
                                            && known.insert(t.taker.clone())
                                        {
                                            tracing::debug!(
                                                "Discovered new trader from trade stream: {}",
                                                t.taker
                                            );
                                            let all: Vec<String> =
                                                known.iter().map(|r| r.clone()).collect();
                                            if let Ok(json) = serde_json::to_string_pretty(&all) {
                                                let _ = std::fs::write("known_traders.json", json);
                                            }
                                        }
                                    }

                                    let price = if t.base_amount > 0.0 {
                                        t.quote_amount / t.base_amount
                                    } else {
                                        0.0
                                    };
                                    serde_json::json!({
                                        "price": price,
                                        "size": t.base_amount,
                                        "side": format!("{:?}", t.side).to_lowercase(),
                                        "timestamp": t.timestamp.timestamp(),
                                    })
                                })
                                .collect();

                            if !trades.is_empty() {
                                cache.touch_relay("trades", &sym);
                                cache.push_trades(&sym, &trades);
                                let msg = WsServerMessage {
                                    channel: "trades".to_string(),
                                    symbol: Some(sym.clone()),
                                    data: serde_json::json!({ "trades": trades }),
                                };
                                bcast.send(&format!("trades:{}", sym), msg);
                            }
                        }
                        Ok(None) => break, // channel closed
                        Err(_) => {
                            tracing::warn!(
                                "Trades relay for {} timed out after {}s with no data — reconnecting",
                                sym, RELAY_RECV_TIMEOUT_SECS
                            );
                            break;
                        }
                    }
                }
                tracing::warn!(
                    "Trades subscription ended for {}, reconnecting in {}s",
                    sym, backoff_secs
                );
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        });
    }

    // Stats relay with auto-reconnect
    {
        let ws = ws_client.clone();
        let bcast = broadcast.clone();
        let cache = cache.clone();
        let sym = symbol.to_string();
        tokio::spawn(async move {
            let mut backoff_secs = 1u64;
            loop {
                let (mut rx, _handle) = match ws.subscribe_to_market(sym.clone()) {
                    Ok(sub) => {
                        backoff_secs = 1;
                        tracing::info!("Stats subscription established for {}", sym);
                        sub
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to subscribe to stats for {}: {:?}, retrying in {}s",
                            sym, e, backoff_secs
                        );
                        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                        backoff_secs = (backoff_secs * 2).min(60);
                        continue;
                    }
                };
                loop {
                    match tokio::time::timeout(
                        Duration::from_secs(RELAY_RECV_TIMEOUT_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Some(update)) => {
                            cache.touch_relay("stats", &sym);
                            let msg = WsServerMessage {
                                channel: "stats".to_string(),
                                symbol: Some(sym.clone()),
                                data: serde_json::json!({
                                    "mark_price": update.mark_price,
                                    "index_price": update.oracle_price,
                                    "last_price": update.mid_price,
                                    "funding_rate": update.funding_rate,
                                    "open_interest": update.open_interest,
                                    "volume_24h": update.day_volume_usd,
                                }),
                            };
                            bcast.send(&format!("stats:{}", sym), msg);
                        }
                        Ok(None) => break,
                        Err(_) => {
                            tracing::warn!(
                                "Stats relay for {} timed out after {}s with no data — reconnecting",
                                sym, RELAY_RECV_TIMEOUT_SECS
                            );
                            break;
                        }
                    }
                }
                tracing::warn!(
                    "Stats subscription ended for {}, reconnecting in {}s",
                    sym, backoff_secs
                );
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        });
    }

    // Candles relay with auto-reconnect
    {
        let ws = ws_client.clone();
        let bcast = broadcast.clone();
        let cache = cache.clone();
        let sym = symbol.to_string();
        tokio::spawn(async move {
            let mut backoff_secs = 1u64;
            loop {
                let (mut rx, _handle) =
                    match ws.subscribe_to_candles(sym.clone(), Timeframe::Minute1) {
                        Ok(sub) => {
                            backoff_secs = 1;
                            tracing::info!("Candles subscription established for {}", sym);
                            sub
                        }
                        Err(e) => {
                            tracing::error!(
                                "Failed to subscribe to candles for {}: {:?}, retrying in {}s",
                                sym, e, backoff_secs
                            );
                            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                            backoff_secs = (backoff_secs * 2).min(60);
                            continue;
                        }
                    };
                loop {
                    match tokio::time::timeout(
                        Duration::from_secs(RELAY_RECV_TIMEOUT_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Some(candle)) => {
                            cache.touch_relay("candles", &sym);
                            let msg = WsServerMessage {
                                channel: "candles".to_string(),
                                symbol: Some(sym.clone()),
                                data: serde_json::json!({
                                    "timeframe": "1m",
                                    "candle": {
                                        "time": candle.candle.time,
                                        "open": candle.candle.open,
                                        "high": candle.candle.high,
                                        "low": candle.candle.low,
                                        "close": candle.candle.close,
                                        "volume": candle.candle.volume,
                                    }
                                }),
                            };
                            bcast.send(&format!("candles:{}", sym), msg);
                        }
                        Ok(None) => break,
                        Err(_) => {
                            tracing::warn!(
                                "Candles relay for {} timed out after {}s with no data — reconnecting",
                                sym, RELAY_RECV_TIMEOUT_SECS
                            );
                            break;
                        }
                    }
                }
                tracing::warn!(
                    "Candles subscription ended for {}, reconnecting in {}s",
                    sym, backoff_secs
                );
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        });
    }

    Ok(())
}

/// Start a per-trader relay using SDK's subscribe_to_trader_state.
/// Uses `active_relays` to prevent duplicate relays for the same pubkey (BE-BUG-1).
/// Cleans up broadcast channel on exit if no subscribers remain (BE-BUG-3).
pub async fn start_trader_relay(
    ws_client: Arc<PhoenixWSClient>,
    broadcast: Arc<BroadcastHub>,
    active_relays: Arc<dashmap::DashSet<String>>,
    pubkey_str: String,
) {
    // BE-BUG-1 FIX: Atomically claim this relay — skip if already running.
    if !active_relays.insert(pubkey_str.clone()) {
        tracing::debug!("Trader relay already active for {}, skipping", pubkey_str);
        return;
    }

    let channel_key = format!("trader_margin:{}", pubkey_str);
    tracing::info!("Starting SDK trader relay for {}", pubkey_str);

    let authority = match Pubkey::from_str(&pubkey_str) {
        Ok(pk) => pk,
        Err(e) => {
            tracing::error!("Invalid pubkey {}: {}", pubkey_str, e);
            active_relays.remove(&pubkey_str);
            return;
        }
    };

    let mut backoff_secs = 1u64;
    loop {
        let (mut rx, _handle) = match ws_client.subscribe_to_trader_state(&authority) {
            Ok(sub) => {
                backoff_secs = 1;
                tracing::info!("Trader state subscription established for {}", pubkey_str);
                sub
            }
            Err(e) => {
                tracing::error!(
                    "Failed to subscribe to trader state for {}: {:?}, retrying in {}s",
                    pubkey_str, e, backoff_secs
                );
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
                continue;
            }
        };

        let mut stopped_by_no_subscribers = false;
        while let Some(update) = rx.recv().await {
            // Stop if no subscribers
            if !broadcast.has_subscribers(&channel_key) {
                tracing::info!("No subscribers for {}, stopping trader relay", channel_key);
                stopped_by_no_subscribers = true;
                break;
            }

            let data = match serde_json::to_value(&update) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("Failed to serialize trader state: {}", e);
                    continue;
                }
            };

            let msg = WsServerMessage {
                channel: "trader_margin".to_string(),
                symbol: None,
                data,
            };
            broadcast.send(&channel_key, msg);
        }

        // If we stopped because no subscribers remain, exit the relay entirely.
        if stopped_by_no_subscribers {
            break;
        }

        // Upstream dropped — reconnect if subscribers still exist.
        if !broadcast.has_subscribers(&channel_key) {
            tracing::info!("No subscribers for {} after disconnect, exiting relay", channel_key);
            break;
        }
        tracing::warn!(
            "Trader state subscription ended for {}, reconnecting in {}s",
            pubkey_str, backoff_secs
        );
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(60);
    }

    // Cleanup: release relay slot
    active_relays.remove(&pubkey_str);

    // BE-BUG-3 FIX: Remove broadcast channel if no subscribers remain.
    if !broadcast.has_subscribers(&channel_key) {
        broadcast.remove_channel(&channel_key);
        tracing::info!("Removed broadcast channel {} (no subscribers)", channel_key);
    }

    tracing::info!("Trader relay ended for {}", pubkey_str);
}
