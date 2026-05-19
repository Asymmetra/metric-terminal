//! Imperial /ws/market relay.
//!
//! Holds one upstream WS connection to Imperial. Every event is:
//!   1. Forwarded to the BroadcastHub on its logical channel.
//!   2. For mark_price_update: also fed into the CandleAggregator and a
//!      synthetic 1m-candle update is broadcast.
//!   3. Recorded in MarketCache for /health/relay age tracking.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::mpsc;

use crate::imperial::candles::{CandleAggregator, Timeframe};
use crate::imperial::ws::{ImperialMarketWs, MarketEvent};
use crate::services::broadcast::BroadcastHub;
use crate::services::market_cache::MarketCache;

pub fn start_market_relay(
    broadcast: Arc<BroadcastHub>,
    candles: Arc<CandleAggregator>,
    market_cache: Arc<MarketCache>,
) {
    let mut rx: mpsc::UnboundedReceiver<MarketEvent> =
        ImperialMarketWs::from_env().spawn();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            handle_event(&broadcast, &candles, &market_cache, ev);
        }
        tracing::warn!("imperial market relay channel closed");
    });
}

fn handle_event(
    broadcast: &Arc<BroadcastHub>,
    candles: &Arc<CandleAggregator>,
    market_cache: &Arc<MarketCache>,
    ev: MarketEvent,
) {
    match ev {
        MarketEvent::MarkPriceUpdate {
            symbol,
            venue,
            source,
            price,
            fetched_at_unix_ms,
        } => {
            market_cache.touch_relay(&format!("mark_prices:{symbol}"));
            broadcast.send_or_create(
                &format!("mark_prices:{symbol}"),
                json!({
                    "type": "mark_price_update",
                    "symbol": symbol,
                    "venue": venue,
                    "source": source,
                    "price": price,
                    "fetchedAtUnixMs": fetched_at_unix_ms,
                }),
            );

            candles.record(&venue, &symbol, price, fetched_at_unix_ms);
            if let Some(bar) = candles
                .get(&venue, &symbol, Timeframe::M1, 1)
                .into_iter()
                .next()
            {
                broadcast.send_or_create(
                    &format!("candles:{symbol}"),
                    json!({
                        "type": "candle_update",
                        "symbol": symbol,
                        "venue": venue,
                        "timeframe": "1m",
                        "candle": bar,
                    }),
                );
            }
        }
        MarketEvent::FundingRateUpdate {
            symbol,
            venue,
            source,
            long_funding_rate_per_hour_percent,
            short_funding_rate_per_hour_percent,
            long_borrow_rate_per_hour_percent,
            short_borrow_rate_per_hour_percent,
        } => {
            market_cache.touch_relay(&format!("funding_rates:{symbol}"));
            broadcast.send_or_create(
                &format!("funding_rates:{symbol}"),
                json!({
                    "type": "funding_rate_update",
                    "symbol": symbol,
                    "venue": venue,
                    "source": source,
                    "longFundingRatePerHourPercent": long_funding_rate_per_hour_percent,
                    "shortFundingRatePerHourPercent": short_funding_rate_per_hour_percent,
                    "longBorrowRatePerHourPercent": long_borrow_rate_per_hour_percent,
                    "shortBorrowRatePerHourPercent": short_borrow_rate_per_hour_percent,
                }),
            );
        }
        MarketEvent::PhoenixDepthUpdate { symbol, snapshot } => {
            market_cache.touch_relay(&format!("phoenix_depth:{symbol}"));
            broadcast.send_or_create(
                &format!("phoenix_depth:{symbol}"),
                json!({
                    "type": "phoenix_depth_update",
                    "symbol": symbol,
                    "snapshot": snapshot,
                }),
            );
        }
        MarketEvent::Other => {}
    }
}
