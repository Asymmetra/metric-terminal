use anyhow::Result;
use dashmap::DashSet;
use std::sync::Arc;
use tokio::sync::RwLock;

use phoenix_sdk::{ExchangeMarketConfig, PhoenixHttpClient, PhoenixMetadata, PhoenixWSClient};

use crate::services::broadcast::BroadcastHub;
use crate::services::market_cache::MarketCache;

/// Cached leaderboard computation result.
pub struct LeaderboardSnapshot {
    pub period: String,
    pub entries: Vec<serde_json::Value>,
    pub computed_at: i64,
}

pub struct AppState {
    pub http_client: PhoenixHttpClient,
    pub ws_client: Arc<PhoenixWSClient>,
    pub metadata: Arc<RwLock<PhoenixMetadata>>,
    pub market_cache: Arc<MarketCache>,
    pub broadcast: Arc<BroadcastHub>,
    pub markets: Arc<RwLock<Vec<ExchangeMarketConfig>>>,
    /// Tracks pubkeys with an active trader relay to prevent duplicates (BE-BUG-1).
    pub active_trader_relays: Arc<DashSet<String>>,
    /// Known trader authorities for leaderboard tracking.
    pub known_traders: Arc<DashSet<String>>,
    /// Cached leaderboard results (5-minute TTL).
    pub leaderboard_cache: RwLock<Option<LeaderboardSnapshot>>,
}

impl AppState {
    pub async fn new() -> Result<Self> {
        tracing::info!("Connecting to Phoenix via SDK...");

        // SDK reads PHOENIX_API_URL, PHOENIX_WS_URL, PHOENIX_API_KEY from env
        let http_client = PhoenixHttpClient::new_from_env();

        // Fetch exchange config to verify connectivity and get market metadata
        let exchange = http_client.get_exchange().await?;
        let markets = exchange.markets.clone();
        let symbols: Vec<String> = markets.iter().map(|m| m.symbol.clone()).collect();
        tracing::info!("Found {} markets: {:?}", symbols.len(), symbols);

        // Build metadata for tx builder
        let metadata = PhoenixMetadata::new(exchange.into());

        // Create SDK WS client (auto-reconnect built in)
        let ws_client = PhoenixWSClient::new_from_env()?;

        let market_cache = Arc::new(MarketCache::new());
        let broadcast = Arc::new(BroadcastHub::new(&symbols));

        // Load known traders from disk for leaderboard persistence
        let known_traders = Arc::new(DashSet::new());
        let traders_path = std::path::Path::new("known_traders.json");
        if traders_path.exists() {
            match std::fs::read_to_string(traders_path) {
                Ok(contents) => {
                    if let Ok(list) = serde_json::from_str::<Vec<String>>(&contents) {
                        let count = list.len();
                        for pubkey in list {
                            known_traders.insert(pubkey);
                        }
                        tracing::info!("Loaded {} known traders from disk", count);
                    }
                }
                Err(e) => tracing::warn!("Failed to read known_traders.json: {}", e),
            }
        }

        Ok(Self {
            http_client,
            ws_client: Arc::new(ws_client),
            metadata: Arc::new(RwLock::new(metadata)),
            market_cache,
            broadcast,
            markets: Arc::new(RwLock::new(markets)),
            active_trader_relays: Arc::new(DashSet::new()),
            known_traders,
            leaderboard_cache: RwLock::new(None),
        })
    }

    pub async fn shutdown(&self) {
        self.ws_client.shutdown();
        tracing::info!("AppState shutdown complete");
    }
}
