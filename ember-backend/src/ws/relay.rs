use crate::phoenix::types::{OrderbookLevel, WsServerMessage};
use crate::services::broadcast::BroadcastHub;
use crate::services::market_cache::MarketCache;
use phoenix_sdk::{PhoenixWSClient, Timeframe};
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;

/// Start the relay that feeds data from Phoenix SDK WS into broadcast channels.
/// Subscribes to real orderbook, trades, stats, and candles for each market.
pub async fn start_relay(
    ws_client: Arc<PhoenixWSClient>,
    market_cache: Arc<MarketCache>,
    broadcast: Arc<BroadcastHub>,
    symbols: Vec<String>,
) {
    for symbol in symbols {
        let ws = ws_client.clone();
        let cache = market_cache.clone();
        let bcast = broadcast.clone();
        let sym = symbol.clone();

        tokio::spawn(async move {
            if let Err(e) = start_market_relay(ws, cache, bcast, &sym).await {
                tracing::error!("Failed to start relay for {}: {:?}", sym, e);
            }
        });
    }
}

/// Subscribe to all channels for a single market and forward to broadcast.
async fn start_market_relay(
    ws_client: Arc<PhoenixWSClient>,
    cache: Arc<MarketCache>,
    broadcast: Arc<BroadcastHub>,
    symbol: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::info!("Starting SDK WS relay for {}", symbol);

    // Subscribe to orderbook — handle must live inside the spawned task
    let (mut ob_rx, ob_handle) = ws_client.subscribe_to_orderbook(symbol.to_string())?;
    let ob_bcast = broadcast.clone();
    let ob_cache = cache.clone();
    let ob_sym = symbol.to_string();
    tokio::spawn(async move {
        let _keep_alive = ob_handle; // prevent drop → unsubscribe
        while let Some(update) = ob_rx.recv().await {
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

            ob_cache.update_orderbook(&ob_sym, bids.clone(), asks.clone());

            let msg = WsServerMessage {
                channel: "orderbook".to_string(),
                symbol: Some(ob_sym.clone()),
                data: serde_json::json!({
                    "bids": bids,
                    "asks": asks,
                }),
            };
            ob_bcast.send(&format!("orderbook:{}", ob_sym), msg);
        }
        tracing::warn!("Orderbook subscription ended for {}", ob_sym);
    });

    // Subscribe to trades — handle must live inside the spawned task
    let (mut trades_rx, trades_handle) = ws_client.subscribe_to_trades(symbol.to_string())?;
    let trades_bcast = broadcast.clone();
    let trades_sym = symbol.to_string();
    tokio::spawn(async move {
        let _keep_alive = trades_handle; // prevent drop → unsubscribe
        while let Some(update) = trades_rx.recv().await {
            let trades: Vec<serde_json::Value> = update
                .trades
                .iter()
                .map(|t| {
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
                let msg = WsServerMessage {
                    channel: "trades".to_string(),
                    symbol: Some(trades_sym.clone()),
                    data: serde_json::json!({ "trades": trades }),
                };
                trades_bcast.send(&format!("trades:{}", trades_sym), msg);
            }
        }
        tracing::warn!("Trades subscription ended for {}", trades_sym);
    });

    // Subscribe to market stats — handle must live inside the spawned task
    let (mut stats_rx, stats_handle) = ws_client.subscribe_to_market(symbol.to_string())?;
    let stats_bcast = broadcast.clone();
    let stats_sym = symbol.to_string();
    tokio::spawn(async move {
        let _keep_alive = stats_handle; // prevent drop → unsubscribe
        while let Some(update) = stats_rx.recv().await {
            let msg = WsServerMessage {
                channel: "stats".to_string(),
                symbol: Some(stats_sym.clone()),
                data: serde_json::json!({
                    "mark_price": update.mark_price,
                    "index_price": update.oracle_price,
                    "last_price": update.mid_price,
                    "funding_rate": update.funding_rate,
                    "open_interest": update.open_interest,
                    "volume_24h": update.day_volume_usd,
                }),
            };
            stats_bcast.send(&format!("stats:{}", stats_sym), msg);
        }
        tracing::warn!("Stats subscription ended for {}", stats_sym);
    });

    // Subscribe to candles (1m timeframe) — handle must live inside the spawned task
    let (mut candles_rx, candles_handle) =
        ws_client.subscribe_to_candles(symbol.to_string(), Timeframe::Minute1)?;
    let candles_bcast = broadcast.clone();
    let candles_sym = symbol.to_string();
    tokio::spawn(async move {
        let _keep_alive = candles_handle; // prevent drop → unsubscribe
        while let Some(candle) = candles_rx.recv().await {
            let msg = WsServerMessage {
                channel: "candles".to_string(),
                symbol: Some(candles_sym.clone()),
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
            candles_bcast.send(&format!("candles:{}", candles_sym), msg);
        }
        tracing::warn!("Candles subscription ended for {}", candles_sym);
    });

    Ok(())
}

/// Start a per-trader relay using SDK's subscribe_to_trader_state.
pub async fn start_trader_relay(
    ws_client: Arc<PhoenixWSClient>,
    broadcast: Arc<BroadcastHub>,
    pubkey_str: String,
) {
    let channel_key = format!("trader_margin:{}", pubkey_str);
    tracing::info!("Starting SDK trader relay for {}", pubkey_str);

    let authority = match Pubkey::from_str(&pubkey_str) {
        Ok(pk) => pk,
        Err(e) => {
            tracing::error!("Invalid pubkey {}: {}", pubkey_str, e);
            return;
        }
    };

    let (mut rx, _handle) = match ws_client.subscribe_to_trader_state(&authority) {
        Ok(sub) => sub,
        Err(e) => {
            tracing::error!("Failed to subscribe to trader state for {}: {:?}", pubkey_str, e);
            return;
        }
    };

    while let Some(update) = rx.recv().await {
        // Stop if no subscribers
        if !broadcast.has_subscribers(&channel_key) {
            tracing::info!("No subscribers for {}, stopping trader relay", channel_key);
            break;
        }

        // Forward the SDK message as JSON to our broadcast
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

    tracing::info!("Trader relay ended for {}", pubkey_str);
}
