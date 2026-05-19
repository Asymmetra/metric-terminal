//! Last-message-seen tracker for /ws/market upstream channels. Powers
//! /health/relay so operators can spot a stale upstream subscription.

use dashmap::DashMap;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct MarketCacheSizes {
    pub relay_timestamps: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelayStatus {
    pub channel: String,
    pub last_ms: Option<i64>,
    pub age_secs: Option<i64>,
}

pub struct MarketCache {
    relay_timestamps: DashMap<String, i64>,
}

impl MarketCache {
    pub fn new() -> Self {
        Self {
            relay_timestamps: DashMap::new(),
        }
    }

    pub fn touch_relay(&self, channel: &str) {
        let now = now_ms();
        self.relay_timestamps.insert(channel.to_string(), now);
    }

    pub fn status(&self) -> Vec<RelayStatus> {
        let now = now_ms();
        let mut out: Vec<RelayStatus> = self
            .relay_timestamps
            .iter()
            .map(|r| {
                let ts = *r.value();
                RelayStatus {
                    channel: r.key().clone(),
                    last_ms: Some(ts),
                    age_secs: Some((now - ts) / 1000),
                }
            })
            .collect();
        out.sort_by(|a, b| a.channel.cmp(&b.channel));
        out
    }

    pub fn sizes(&self) -> MarketCacheSizes {
        MarketCacheSizes {
            relay_timestamps: self.relay_timestamps.len(),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
