//! Channel fan-out hub. The backend subscribes once to upstream sources
//! (Imperial /ws/market) and rebroadcasts to N connected /ws clients.
//!
//! Messages are serde_json::Value — the relay layer already knows the
//! shape it's forwarding, and keeping the hub generic over Value avoids
//! coupling to upstream DTOs.

use dashmap::DashMap;
use serde_json::Value;
use tokio::sync::broadcast;

const CHANNEL_CAPACITY: usize = 256;

pub struct BroadcastHub {
    channels: DashMap<String, broadcast::Sender<Value>>,
}

impl BroadcastHub {
    /// Seed the hub with a set of prefix-only "anchor" channels. Per-symbol
    /// channels (`mark_prices:SOL`, `funding_rates:SOL`, etc.) are created
    /// lazily on first subscribe to avoid baking in a symbol list at boot.
    pub fn new(prefixes: &[&str]) -> Self {
        let channels = DashMap::new();
        for &p in prefixes {
            let key = format!("{p}:*");
            let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
            channels.insert(key, tx);
        }
        Self { channels }
    }

    #[allow(dead_code)]
    pub fn subscribe(&self, key: &str) -> Option<broadcast::Receiver<Value>> {
        self.channels.get(key).map(|tx| tx.subscribe())
    }

    /// Subscribe to a channel, creating it on-demand if it doesn't exist.
    /// Used for per-symbol channels like `mark_prices:SOL`.
    pub fn subscribe_or_create(&self, key: &str) -> broadcast::Receiver<Value> {
        self.channels
            .entry(key.to_string())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
                tx
            })
            .subscribe()
    }

    /// Check if a channel has any active subscribers.
    #[allow(dead_code)]
    pub fn has_subscribers(&self, key: &str) -> bool {
        self.channels
            .get(key)
            .map(|tx| tx.receiver_count() > 0)
            .unwrap_or(false)
    }

    /// Send to an existing channel; no-op if missing or no subscribers.
    #[allow(dead_code)]
    pub fn send(&self, key: &str, msg: Value) {
        if let Some(tx) = self.channels.get(key) {
            let _ = tx.send(msg);
        }
    }

    /// Send-or-create. Use when the relay is producing a stream for a
    /// dynamically-discovered key. Drops on the floor if no subscribers
    /// are attached (avoids the unbounded-channel-buffer hazard).
    pub fn send_or_create(&self, key: &str, msg: Value) {
        let tx = self
            .channels
            .entry(key.to_string())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
                tx
            })
            .clone();
        let _ = tx.send(msg);
    }

    /// Remove a dynamically-created channel. Prevents unbounded DashMap
    /// growth from one-off subscriptions.
    #[allow(dead_code)]
    pub fn remove_channel(&self, key: &str) {
        self.channels.remove(key);
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    pub fn total_subscribers(&self) -> usize {
        self.channels.iter().map(|r| r.value().receiver_count()).sum()
    }

    pub fn subscribers_by_prefix(&self) -> std::collections::BTreeMap<String, usize> {
        let mut out: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for r in self.channels.iter() {
            let prefix = r.key().split(':').next().unwrap_or("?").to_string();
            *out.entry(prefix).or_insert(0) += r.value().receiver_count();
        }
        out
    }
}
