use std::sync::Arc;

use crate::imperial::candles::CandleAggregator;
use crate::imperial::http::ImperialHttp;
use crate::services::broadcast::BroadcastHub;
use crate::services::market_cache::MarketCache;

/// Logical channel prefixes broadcast to /ws clients. Per-symbol channels
/// (`mark_prices:SOL`, …) are created lazily on first subscribe so the
/// backend doesn't need to know the symbol list at boot.
pub const CHANNEL_PREFIXES: &[&str] = &[
    "mark_prices",
    "funding_rates",
    "phoenix_depth",
    "candles",
];

pub struct AppState {
    pub imperial: ImperialHttp,
    pub broadcast: Arc<BroadcastHub>,
    pub candles: Arc<CandleAggregator>,
    pub market_cache: Arc<MarketCache>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            imperial: ImperialHttp::from_env(),
            broadcast: Arc::new(BroadcastHub::new(CHANNEL_PREFIXES)),
            candles: CandleAggregator::new(),
            market_cache: Arc::new(MarketCache::new()),
        }
    }
}
