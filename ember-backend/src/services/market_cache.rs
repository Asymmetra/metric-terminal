use crate::phoenix::types::{OrderbookLevel, OrderbookSnapshot};
use dashmap::DashMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct MarketCache {
    orderbooks: DashMap<String, OrderbookSnapshot>,
}

impl MarketCache {
    pub fn new() -> Self {
        Self {
            orderbooks: DashMap::new(),
        }
    }

    pub fn get_orderbook(&self, symbol: &str) -> Option<OrderbookSnapshot> {
        self.orderbooks.get(symbol).map(|r| OrderbookSnapshot {
            bids: r.bids.clone(),
            asks: r.asks.clone(),
            symbol: r.symbol.clone(),
            timestamp: r.timestamp,
        })
    }

    pub fn update_orderbook(&self, symbol: &str, bids: Vec<OrderbookLevel>, asks: Vec<OrderbookLevel>) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let snapshot = OrderbookSnapshot {
            bids,
            asks,
            symbol: symbol.to_string(),
            timestamp: now,
        };

        self.orderbooks.insert(symbol.to_string(), snapshot);
    }
}
