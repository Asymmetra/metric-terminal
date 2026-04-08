use crate::phoenix::types::{OrderbookLevel, OrderbookSnapshot};
use dashmap::DashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// Tracks the last time data was received per channel type per symbol.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RelayStatus {
    pub symbol: String,
    pub orderbook_last_ms: Option<i64>,
    pub trades_last_ms: Option<i64>,
    pub stats_last_ms: Option<i64>,
    pub candles_last_ms: Option<i64>,
}

const MAX_RECENT_TRADES: usize = 50;

pub struct MarketCache {
    orderbooks: DashMap<String, OrderbookSnapshot>,
    /// Last-received timestamps per "channel:SYMBOL" key (e.g. "trades:SOL")
    relay_timestamps: DashMap<String, i64>,
    /// Recent trades per symbol (ring buffer, newest last)
    recent_trades: DashMap<String, Vec<serde_json::Value>>,
}

impl MarketCache {
    pub fn new() -> Self {
        Self {
            orderbooks: DashMap::new(),
            relay_timestamps: DashMap::new(),
            recent_trades: DashMap::new(),
        }
    }

    /// Record the current time as the last data received for a relay channel.
    pub fn touch_relay(&self, channel: &str, symbol: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        self.relay_timestamps
            .insert(format!("{}:{}", channel, symbol.to_uppercase()), now);
    }

    /// Buffer recent trades for a symbol (called from relay).
    pub fn push_trades(&self, symbol: &str, trades: &[serde_json::Value]) {
        let key = symbol.to_uppercase();
        let mut entry = self.recent_trades.entry(key).or_default();
        entry.extend_from_slice(trades);
        if entry.len() > MAX_RECENT_TRADES {
            let excess = entry.len() - MAX_RECENT_TRADES;
            entry.drain(..excess);
        }
    }

    /// Get recent trades for a symbol.
    pub fn get_recent_trades(&self, symbol: &str) -> Vec<serde_json::Value> {
        let key = symbol.to_uppercase();
        self.recent_trades
            .get(&key)
            .map(|r| r.clone())
            .unwrap_or_default()
    }

    /// Get relay status for all known symbols.
    pub fn relay_status(&self, symbols: &[String]) -> Vec<RelayStatus> {
        symbols
            .iter()
            .map(|sym| {
                let key = sym.to_uppercase();
                RelayStatus {
                    symbol: key.clone(),
                    orderbook_last_ms: self.relay_timestamps.get(&format!("orderbook:{}", key)).map(|r| *r),
                    trades_last_ms: self.relay_timestamps.get(&format!("trades:{}", key)).map(|r| *r),
                    stats_last_ms: self.relay_timestamps.get(&format!("stats:{}", key)).map(|r| *r),
                    candles_last_ms: self.relay_timestamps.get(&format!("candles:{}", key)).map(|r| *r),
                }
            })
            .collect()
    }

    pub fn get_orderbook(&self, symbol: &str) -> Option<OrderbookSnapshot> {
        let key = symbol.to_uppercase();
        self.orderbooks.get(&key).map(|r| OrderbookSnapshot {
            bids: r.bids.clone(),
            asks: r.asks.clone(),
            symbol: r.symbol.clone(),
            timestamp: r.timestamp,
        })
    }

    pub fn update_orderbook(&self, symbol: &str, bids: Vec<OrderbookLevel>, asks: Vec<OrderbookLevel>) {
        let key = symbol.to_uppercase();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let snapshot = OrderbookSnapshot {
            bids,
            asks,
            symbol: key.clone(),
            timestamp: now,
        };

        self.orderbooks.insert(key, snapshot);
    }
}
