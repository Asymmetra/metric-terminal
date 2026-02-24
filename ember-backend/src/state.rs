use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;

use phoenix_sdk::{ExchangeMarketConfig, PhoenixHttpClient, PhoenixMetadata, PhoenixWSClient};

use crate::services::broadcast::BroadcastHub;
use crate::services::market_cache::MarketCache;

pub struct AppState {
    pub http_client: PhoenixHttpClient,
    pub ws_client: Arc<PhoenixWSClient>,
    pub metadata: Arc<RwLock<PhoenixMetadata>>,
    pub market_cache: Arc<MarketCache>,
    pub broadcast: Arc<BroadcastHub>,
    pub markets: Arc<RwLock<Vec<ExchangeMarketConfig>>>,
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

        Ok(Self {
            http_client,
            ws_client: Arc::new(ws_client),
            metadata: Arc::new(RwLock::new(metadata)),
            market_cache,
            broadcast,
            markets: Arc::new(RwLock::new(markets)),
        })
    }

    pub async fn shutdown(&self) {
        self.ws_client.shutdown();
        tracing::info!("AppState shutdown complete");
    }
}
