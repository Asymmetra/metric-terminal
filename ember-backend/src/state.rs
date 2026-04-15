use anyhow::{anyhow, Result};
use dashmap::DashSet;
use std::sync::Arc;
use tokio::sync::RwLock;

use phoenix_sdk::{ExchangeMarketConfig, PhoenixClient, PhoenixHttpClient, PhoenixMetadata};

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
    pub ws_client: PhoenixClient,
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

        // Create SDK high-level client — manages the WS connection with
        // auto-reconnect and automatic resubscription. The low-level
        // PhoenixWSClient has no reconnect; using it directly left us
        // zombied after the first upstream disconnect.
        let ws_client = PhoenixClient::new_from_env()
            .await
            .map_err(|e| anyhow!("PhoenixClient init failed: {:?}", e))?;

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
            ws_client,
            metadata: Arc::new(RwLock::new(metadata)),
            market_cache,
            broadcast,
            markets: Arc::new(RwLock::new(markets)),
            active_trader_relays: Arc::new(DashSet::new()),
            known_traders,
            leaderboard_cache: RwLock::new(None),
        })
    }

    /// Re-fetch exchange config from Phoenix API and update metadata + markets.
    pub async fn refresh_metadata(&self) -> Result<()> {
        let exchange = self.http_client.get_exchange().await?;
        let new_markets = exchange.markets.clone();
        let symbols: Vec<String> = new_markets.iter().map(|m| m.symbol.clone()).collect();
        let new_metadata = PhoenixMetadata::new(exchange.into());

        {
            let mut metadata = self.metadata.write().await;
            *metadata = new_metadata;
        }
        {
            let mut markets = self.markets.write().await;
            *markets = new_markets;
        }

        tracing::info!("Metadata refreshed — {} markets: {:?}", symbols.len(), symbols);
        Ok(())
    }

    /// Look up a market symbol; if not found, refresh metadata once and retry.
    pub async fn ensure_market(&self, symbol: &str) -> Result<()> {
        {
            let metadata = self.metadata.read().await;
            if metadata.get_market(symbol).is_some() {
                return Ok(());
            }
        }
        tracing::info!("Market '{}' not found — refreshing metadata", symbol);
        self.refresh_metadata().await?;
        {
            let metadata = self.metadata.read().await;
            metadata
                .get_market(symbol)
                .ok_or_else(|| anyhow::anyhow!("Unknown symbol after refresh: {}", symbol))?;
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.ws_client.shutdown();
        tracing::info!("AppState shutdown complete");
    }
}
