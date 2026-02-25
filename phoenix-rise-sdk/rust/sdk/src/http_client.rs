//! HTTP client for Phoenix API.
//!
//! This module provides a client for making HTTP requests to the Phoenix API
//! to fetch exchange configuration and market data.

use std::time::Duration;

use phoenix_types::{
    ApiCandle, CandlesQueryParams, CollateralHistoryQueryParams, CollateralHistoryResponse,
    ExchangeKeysView, ExchangeMarketConfig, ExchangeResponse, FundingHistoryQueryParams,
    FundingHistoryResponse, OrderHistoryQueryParams, OrderHistoryResponse, PhoenixHttpError,
    PnlPoint, PnlQueryParams, TradeHistoryQueryParams, TradeHistoryResponse, TraderKey,
    TraderStateResponse, TraderView,
};
use reqwest::header::RETRY_AFTER;
use reqwest::{Client, RequestBuilder, Response};
use solana_pubkey::Pubkey;
use tracing::debug;

use crate::env::PhoenixEnv;

const API_KEY_HEADER: &str = "x-api-key";
const RATE_LIMIT_STATUS: u16 = 429;

/// Automatic retry behavior for HTTP 429 (rate-limited) responses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitRetryConfig {
    /// Enable automatic retry on HTTP 429.
    pub enabled: bool,
    /// Maximum number of retries after the initial attempt.
    pub max_retries: u32,
    /// Maximum total time spent sleeping between retries.
    pub max_total_wait: Duration,
    /// Fallback delay if `Retry-After` is missing or invalid.
    pub fallback_delay: Duration,
    /// Maximum delay per retry attempt.
    pub max_delay: Duration,
}

impl Default for RateLimitRetryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_retries: 2,
            max_total_wait: Duration::from_secs(15),
            fallback_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(10),
        }
    }
}

/// HTTP client for Phoenix API.
///
/// Provides methods for fetching exchange configuration and market data
/// from the Phoenix perpetuals API.
///
/// # Example
///
/// ```no_run
/// use phoenix_sdk::PhoenixHttpClient;
///
/// #[tokio::main]
/// async fn main() -> Result<(), Box<dyn std::error::Error>> {
///     // Load from environment variables
///     let client = PhoenixHttpClient::new_from_env();
///
///     // Get exchange keys
///     let exchange_keys = client.get_exchange_keys().await?;
///     println!("Global config: {}", exchange_keys.global_config);
///
///     // Get market config (static configuration, not live data)
///     let market = client.get_market("SOL").await?;
///     println!("SOL taker fee: {:.4}%", market.taker_fee * 100.0);
///
///     Ok(())
/// }
/// ```
#[derive(Debug, Clone)]
pub struct PhoenixHttpClient {
    api_url: String,
    api_key: Option<String>,
    client: Client,
    rate_limit_retry: RateLimitRetryConfig,
}

impl PhoenixHttpClient {
    /// Creates a new HTTP client using environment variables.
    ///
    /// Uses `PhoenixEnv::load()` to read configuration from environment.
    pub fn new_from_env() -> Self {
        Self::from_env(PhoenixEnv::load())
    }

    /// Creates a new HTTP client from a `PhoenixEnv`.
    pub fn from_env(env: PhoenixEnv) -> Self {
        Self {
            api_url: env.api_url,
            api_key: env.api_key,
            client: Client::new(),
            rate_limit_retry: RateLimitRetryConfig::default(),
        }
    }

    /// Creates a new HTTP client with the given API URL and API key.
    ///
    /// # Arguments
    ///
    /// * `api_url` - Base URL for the Phoenix API (e.g., "https://api.phoenix.trade/v1")
    /// * `api_key` - API key for authentication
    pub fn new(api_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            api_url: api_url.into(),
            api_key: Some(api_key.into()),
            client: Client::new(),
            rate_limit_retry: RateLimitRetryConfig::default(),
        }
    }

    /// Creates a new HTTP client without an API key.
    pub fn new_public(api_url: impl Into<String>) -> Self {
        Self {
            api_url: api_url.into(),
            api_key: None,
            client: Client::new(),
            rate_limit_retry: RateLimitRetryConfig::default(),
        }
    }

    /// Sets automatic rate-limit retry behavior for this client.
    pub fn set_rate_limit_retry_config(&mut self, config: RateLimitRetryConfig) {
        self.rate_limit_retry = config;
    }

    /// Builder-style variant of [`Self::set_rate_limit_retry_config`].
    pub fn with_rate_limit_retry_config(mut self, config: RateLimitRetryConfig) -> Self {
        self.rate_limit_retry = config;
        self
    }

    /// Returns the current automatic rate-limit retry configuration.
    pub fn rate_limit_retry_config(&self) -> &RateLimitRetryConfig {
        &self.rate_limit_retry
    }

    fn maybe_add_api_key(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => request.header(API_KEY_HEADER, key),
            None => request,
        }
    }

    async fn send_with_rate_limit_retry(
        &self,
        mut request: RequestBuilder,
    ) -> Result<Response, PhoenixHttpError> {
        let mut retries: u32 = 0;
        let mut total_wait = Duration::ZERO;

        loop {
            let retry_request = request.try_clone();
            let response = request.send().await?;

            if response.status().as_u16() != RATE_LIMIT_STATUS {
                return Ok(response);
            }

            let retry_after_seconds = parse_retry_after_seconds(response.headers());
            let message = response.text().await.unwrap_or_default();
            let attempts = retries.saturating_add(1);

            let can_retry =
                self.rate_limit_retry.enabled && retries < self.rate_limit_retry.max_retries;
            if !can_retry {
                return Err(PhoenixHttpError::RateLimited {
                    retry_after_seconds,
                    message,
                    attempts,
                });
            }

            let Some(next_request) = retry_request else {
                return Err(PhoenixHttpError::RateLimited {
                    retry_after_seconds,
                    message: if message.is_empty() {
                        "rate_limited (request could not be cloned for retry)".to_string()
                    } else {
                        message
                    },
                    attempts,
                });
            };

            let wait = retry_after_seconds
                .map(Duration::from_secs)
                .unwrap_or(self.rate_limit_retry.fallback_delay)
                .min(self.rate_limit_retry.max_delay);
            let next_total_wait = total_wait.saturating_add(wait);

            if next_total_wait > self.rate_limit_retry.max_total_wait {
                return Err(PhoenixHttpError::RateLimited {
                    retry_after_seconds,
                    message: if message.is_empty() {
                        "rate_limited (max_total_wait exceeded)".to_string()
                    } else {
                        message
                    },
                    attempts,
                });
            }

            debug!(
                "HTTP rate limited, retrying attempt {} in {:?} (retry_after={:?})",
                attempts + 1,
                wait,
                retry_after_seconds
            );

            tokio::time::sleep(wait).await;
            total_wait = next_total_wait;
            retries = retries.saturating_add(1);
            request = next_request;
        }
    }

    /// Fetches the exchange keys and configuration.
    ///
    /// Returns the global configuration addresses, authority keys, and
    /// other exchange-level data.
    pub async fn get_exchange_keys(&self) -> Result<ExchangeKeysView, PhoenixHttpError> {
        let url = format!("{}/exchange/keys", self.api_url);

        let response = self
            .send_with_rate_limit_retry(self.maybe_add_api_key(self.client.get(&url)))
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse ExchangeKeysView: {}", e))
        })
    }

    /// Fetches static market configuration for all markets.
    ///
    /// Returns market configuration including fees, leverage tiers, and risk
    /// factors. Does NOT include live data like prices or open interest.
    pub async fn get_markets(&self) -> Result<Vec<ExchangeMarketConfig>, PhoenixHttpError> {
        let url = format!("{}/exchange/markets", self.api_url);

        let response = self
            .send_with_rate_limit_retry(self.maybe_add_api_key(self.client.get(&url)))
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response
            .json()
            .await
            .map_err(|e| PhoenixHttpError::ParseFailed(format!("Failed to parse markets: {}", e)))
    }

    /// Fetches static market configuration for a specific symbol.
    ///
    /// # Arguments
    ///
    /// * `symbol` - Trading symbol (e.g., "SOL", "BTC", "ETH")
    ///
    /// Returns market configuration including fees, leverage tiers, and risk
    /// factors. Does NOT include live data like prices or open interest.
    pub async fn get_market(&self, symbol: &str) -> Result<ExchangeMarketConfig, PhoenixHttpError> {
        let symbol_upper = symbol.to_ascii_uppercase();
        let url = format!("{}/exchange/market/{}", self.api_url, symbol_upper);

        let response = self
            .send_with_rate_limit_retry(self.maybe_add_api_key(self.client.get(&url)))
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse ExchangeMarketConfig: {}", e))
        })
    }

    /// Fetches the full exchange configuration including keys and market
    /// configs.
    ///
    /// Returns exchange keys and static market parameters. Does NOT include
    /// live data like mark prices, open interest, or current funding rates.
    pub async fn get_exchange(&self) -> Result<ExchangeResponse, PhoenixHttpError> {
        let url = format!("{}/exchange", self.api_url);

        let response = self
            .send_with_rate_limit_retry(self.maybe_add_api_key(self.client.get(&url)))
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        let body = response.text().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to read response body: {}", e))
        })?;

        serde_json::from_str(&body).map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse ExchangeResponse: {}", e))
        })
    }

    /// Fetches all trader subaccounts for an authority pubkey.
    ///
    /// Returns all subaccounts (cross-margin and isolated) for the given
    /// authority.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    ///
    /// Returns a vector of all trader subaccounts.
    pub async fn get_traders(
        &self,
        authority: &Pubkey,
    ) -> Result<Vec<TraderView>, PhoenixHttpError> {
        self.get_traders_internal(authority, 0).await
    }

    /// Fetches all trader subaccounts for a given authority and PDA index.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `pda_index` - The PDA index (usually 0)
    ///
    /// Returns a vector of all trader subaccounts.
    async fn get_traders_internal(
        &self,
        authority: &Pubkey,
        pda_index: u8,
    ) -> Result<Vec<TraderView>, PhoenixHttpError> {
        let url = format!("{}/trader/{}/state", self.api_url, authority);

        let response = self
            .send_with_rate_limit_retry(
                self.maybe_add_api_key(self.client.get(&url))
                    .query(&[("pdaIndex", pda_index)]),
            )
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        let resp: TraderStateResponse = response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse TraderStateResponse: {}", e))
        })?;

        Ok(resp.traders)
    }

    /// Fetches collateral history for an authority pubkey.
    ///
    /// Uses default PDA index (0) to fetch the collateral history.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including limit and pagination cursors
    ///
    /// Returns a paginated list of collateral events (deposits and
    /// withdrawals).
    ///
    /// # Example
    ///
    /// ```no_run
    /// use std::str::FromStr;
    ///
    /// use phoenix_sdk::{CollateralHistoryQueryParams, PhoenixHttpClient};
    /// use solana_pubkey::Pubkey;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = PhoenixHttpClient::new_from_env();
    ///     let authority = Pubkey::from_str("YOUR_AUTHORITY_PUBKEY")?;
    ///
    ///     // Get last 100 collateral events
    ///     let params = CollateralHistoryQueryParams::new(100);
    ///     let response = client.get_collateral_history(&authority, params).await?;
    ///
    ///     for event in response.data {
    ///         println!(
    ///             "{}: {} {} (balance after: {})",
    ///             event.timestamp, event.event_type, event.amount, event.collateral_after
    ///         );
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_collateral_history(
        &self,
        authority: &Pubkey,
        params: CollateralHistoryQueryParams,
    ) -> Result<CollateralHistoryResponse, PhoenixHttpError> {
        self.get_collateral_history_internal(authority, params)
            .await
    }

    /// Fetches collateral history for a trader using a TraderKey.
    ///
    /// Uses the TraderKey's pda_index for the query.
    ///
    /// # Arguments
    ///
    /// * `trader_key` - The TraderKey containing authority and indices
    /// * `params` - Query parameters including limit and pagination cursors
    ///
    /// Returns a paginated list of collateral events (deposits and
    /// withdrawals).
    pub async fn get_collateral_history_with_trader_key(
        &self,
        trader_key: &TraderKey,
        params: CollateralHistoryQueryParams,
    ) -> Result<CollateralHistoryResponse, PhoenixHttpError> {
        let params = params.with_pda_index(trader_key.pda_index);
        self.get_collateral_history_internal(&trader_key.authority(), params)
            .await
    }

    /// Fetches collateral history by authority.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including pda_index, limit, and pagination
    ///   cursors
    ///
    /// Returns a paginated list of collateral events (deposits and
    /// withdrawals).
    async fn get_collateral_history_internal(
        &self,
        authority: &Pubkey,
        params: CollateralHistoryQueryParams,
    ) -> Result<CollateralHistoryResponse, PhoenixHttpError> {
        let url = format!("{}/trader/{}/collateral-history", self.api_url, authority);

        let mut request = self.maybe_add_api_key(self.client.get(&url)).query(&[
            ("pdaIndex", params.pda_index.to_string()),
            ("limit", params.request.limit.to_string()),
        ]);

        if let Some(next_cursor) = &params.request.next_cursor {
            request = request.query(&[("nextCursor", next_cursor)]);
        }
        if let Some(prev_cursor) = &params.request.prev_cursor {
            request = request.query(&[("prevCursor", prev_cursor)]);
        }
        if let Some(cursor) = &params.request.cursor {
            request = request.query(&[("cursor", cursor)]);
        }

        let response = self.send_with_rate_limit_retry(request).await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!(
                "Failed to parse CollateralHistoryResponse: {}",
                e
            ))
        })
    }

    /// Fetches funding history for an authority pubkey.
    ///
    /// Uses default indices (pda_index=0, subaccount_index=0) to derive the
    /// trader PDA.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including symbol filter, time range,
    ///   limit, and pagination
    ///
    /// Returns a paginated list of funding payment events.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use std::str::FromStr;
    ///
    /// use phoenix_sdk::{FundingHistoryQueryParams, PhoenixHttpClient};
    /// use solana_pubkey::Pubkey;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = PhoenixHttpClient::new_from_env();
    ///     let authority = Pubkey::from_str("YOUR_AUTHORITY_PUBKEY")?;
    ///
    ///     // Get last 100 funding events for SOL
    ///     let params = FundingHistoryQueryParams::new()
    ///         .with_symbol("SOL")
    ///         .with_limit(100);
    ///     let response = client.get_funding_history(&authority, params).await?;
    ///
    ///     for event in response.events {
    ///         println!(
    ///             "{}: {} {} USDC",
    ///             event.timestamp, event.symbol, event.funding_payment
    ///         );
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_funding_history(
        &self,
        authority: &Pubkey,
        params: FundingHistoryQueryParams,
    ) -> Result<FundingHistoryResponse, PhoenixHttpError> {
        self.get_funding_history_internal(authority, params).await
    }

    /// Fetches funding history for a trader using a TraderKey.
    ///
    /// Uses the TraderKey's pda_index for the query.
    ///
    /// # Arguments
    ///
    /// * `trader_key` - The TraderKey containing authority and indices
    /// * `params` - Query parameters including symbol filter, time range,
    ///   limit, and pagination
    ///
    /// Returns a paginated list of funding payment events.
    pub async fn get_funding_history_with_trader_key(
        &self,
        trader_key: &TraderKey,
        params: FundingHistoryQueryParams,
    ) -> Result<FundingHistoryResponse, PhoenixHttpError> {
        let params = params.with_pda_index(trader_key.pda_index);
        self.get_funding_history_internal(&trader_key.authority(), params)
            .await
    }

    /// Fetches funding history by authority.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including pda_index, symbol filter, time
    ///   range, limit, and pagination
    ///
    /// Returns a paginated list of funding payment events.
    async fn get_funding_history_internal(
        &self,
        authority: &Pubkey,
        params: FundingHistoryQueryParams,
    ) -> Result<FundingHistoryResponse, PhoenixHttpError> {
        let url = format!("{}/trader/{}/funding-history", self.api_url, authority);

        let mut request = self.maybe_add_api_key(self.client.get(&url));

        if let Some(symbol) = &params.symbol {
            request = request.query(&[("symbol", symbol)]);
        }
        if let Some(start_time) = params.start_time {
            request = request.query(&[("startTime", start_time)]);
        }
        if let Some(end_time) = params.end_time {
            request = request.query(&[("endTime", end_time)]);
        }
        if let Some(limit) = params.limit {
            request = request.query(&[("limit", limit)]);
        }
        if let Some(cursor) = &params.cursor {
            request = request.query(&[("cursor", cursor)]);
        }

        let response = self.send_with_rate_limit_retry(request).await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        let body = response.text().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to read response body: {}", e))
        })?;

        serde_json::from_str(&body).map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse FundingHistoryResponse: {}", e))
        })
    }

    /// Fetches order history for an authority pubkey.
    ///
    /// Uses default PDA index (0) to fetch the order history.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including limit, market filter, and cursor
    ///
    /// Returns a paginated list of order history items.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use std::str::FromStr;
    ///
    /// use phoenix_sdk::{OrderHistoryQueryParams, PhoenixHttpClient};
    /// use solana_pubkey::Pubkey;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = PhoenixHttpClient::new_from_env();
    ///     let authority = Pubkey::from_str("YOUR_AUTHORITY_PUBKEY")?;
    ///
    ///     // Get last 100 orders
    ///     let params = OrderHistoryQueryParams::new(100);
    ///     let response = client.get_order_history(&authority, params).await?;
    ///
    ///     for order in response.data {
    ///         println!(
    ///             "{}: {:?} {:?} {} @ {}",
    ///             order.market_symbol, order.status, order.side, order.base_qty, order.price
    ///         );
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_order_history(
        &self,
        authority: &Pubkey,
        params: OrderHistoryQueryParams,
    ) -> Result<OrderHistoryResponse, PhoenixHttpError> {
        self.get_order_history_internal(authority, params).await
    }

    /// Fetches order history for a trader using a TraderKey.
    ///
    /// Uses the TraderKey's pda_index for the query.
    ///
    /// # Arguments
    ///
    /// * `trader_key` - The TraderKey containing authority and indices
    /// * `params` - Query parameters including limit, market filter, and cursor
    ///
    /// Returns a paginated list of order history items.
    pub async fn get_order_history_with_trader_key(
        &self,
        trader_key: &TraderKey,
        params: OrderHistoryQueryParams,
    ) -> Result<OrderHistoryResponse, PhoenixHttpError> {
        let params = params.with_pda_index(trader_key.pda_index);
        self.get_order_history_internal(&trader_key.authority(), params)
            .await
    }

    /// Fetches order history by authority.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including pda_index, limit, market filter,
    ///   and cursor
    ///
    /// Returns a paginated list of order history items.
    async fn get_order_history_internal(
        &self,
        authority: &Pubkey,
        params: OrderHistoryQueryParams,
    ) -> Result<OrderHistoryResponse, PhoenixHttpError> {
        let url = format!("{}/trader/{}/order-history", self.api_url, authority);

        let mut request = self
            .maybe_add_api_key(self.client.get(&url))
            .query(&[("limit", params.limit)]);

        if let Some(pda_index) = params.trader_pda_index {
            request = request.query(&[("traderPdaIndex", pda_index)]);
        }
        if let Some(market_symbol) = &params.market_symbol {
            request = request.query(&[("marketSymbol", market_symbol)]);
        }
        if let Some(cursor) = &params.cursor {
            request = request.query(&[("cursor", cursor)]);
        }
        if let Some(privy_id) = &params.privy_id {
            request = request.query(&[("privyId", privy_id)]);
        }

        let response = self.send_with_rate_limit_retry(request).await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse OrderHistoryResponse: {}", e))
        })
    }

    /// Fetches historical candle data.
    ///
    /// # Arguments
    ///
    /// * `params` - Query parameters including symbol, timeframe, time range,
    ///   and limit
    ///
    /// Returns a vector of candles sorted by time (oldest first).
    ///
    /// # Example
    ///
    /// ```no_run
    /// use phoenix_sdk::{CandlesQueryParams, PhoenixHttpClient, Timeframe};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = PhoenixHttpClient::new_from_env();
    ///
    ///     // Get last 100 1-minute candles for SOL
    ///     let params = CandlesQueryParams::new("SOL", Timeframe::Minute1).with_limit(100);
    ///     let candles = client.get_candles(params).await?;
    ///
    ///     for candle in candles {
    ///         println!(
    ///             "time={} open={} close={}",
    ///             candle.time, candle.open, candle.close
    ///         );
    ///     }
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_candles(
        &self,
        params: CandlesQueryParams,
    ) -> Result<Vec<ApiCandle>, PhoenixHttpError> {
        let url = format!("{}/candles", self.api_url);

        let mut request = self
            .maybe_add_api_key(self.client.get(&url))
            .query(&[("symbol", &params.symbol), ("timeframe", &params.timeframe)]);

        if let Some(start_time) = params.start_time {
            request = request.query(&[("startTime", start_time)]);
        }
        if let Some(end_time) = params.end_time {
            request = request.query(&[("endTime", end_time)]);
        }
        if let Some(limit) = params.limit {
            request = request.query(&[("limit", limit)]);
        }

        let response = self.send_with_rate_limit_retry(request).await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse candles response: {}", e))
        })
    }

    /// Fetches trade history (fills) for an authority pubkey.
    ///
    /// Uses default PDA index (0) to fetch the trade history.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including market filter, limit, and cursor
    ///
    /// Returns a paginated list of fill records.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use std::str::FromStr;
    ///
    /// use phoenix_sdk::{PhoenixHttpClient, TradeHistoryQueryParams};
    /// use solana_pubkey::Pubkey;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = PhoenixHttpClient::new_from_env();
    ///     let authority = Pubkey::from_str("YOUR_AUTHORITY_PUBKEY")?;
    ///
    ///     // Get last 100 trades for this trader
    ///     let params = TradeHistoryQueryParams::new().with_limit(100);
    ///     let response = client.get_trade_history(&authority, params).await?;
    ///
    ///     for fill in response.data {
    ///         println!("{}: {} @ {}", fill.timestamp, fill.base_qty, fill.price);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_trade_history(
        &self,
        authority: &Pubkey,
        params: TradeHistoryQueryParams,
    ) -> Result<TradeHistoryResponse, PhoenixHttpError> {
        self.get_trade_history_internal(authority, params).await
    }

    /// Fetches trade history (fills) for a trader using a TraderKey.
    ///
    /// Uses the TraderKey's pda_index for the query.
    ///
    /// # Arguments
    ///
    /// * `trader_key` - The TraderKey containing authority and indices
    /// * `params` - Query parameters including market filter, limit, and cursor
    ///
    /// Returns a paginated list of fill records.
    pub async fn get_trade_history_with_trader_key(
        &self,
        trader_key: &TraderKey,
        params: TradeHistoryQueryParams,
    ) -> Result<TradeHistoryResponse, PhoenixHttpError> {
        let params = params.with_pda_index(trader_key.pda_index);
        self.get_trade_history_internal(&trader_key.authority(), params)
            .await
    }

    /// Fetches trade history by authority.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including pda_index, market filter, limit,
    ///   and cursor
    ///
    /// Returns a paginated list of fill records.
    async fn get_trade_history_internal(
        &self,
        authority: &Pubkey,
        params: TradeHistoryQueryParams,
    ) -> Result<TradeHistoryResponse, PhoenixHttpError> {
        let url = format!("{}/trader/{}/trades-history", self.api_url, authority);

        let mut request = self
            .maybe_add_api_key(self.client.get(&url))
            .query(&[("pdaIndex", params.pda_index)]);

        if let Some(market_symbol) = &params.market_symbol {
            request = request.query(&[("market_symbol", market_symbol)]);
        }
        if let Some(limit) = params.limit {
            request = request.query(&[("limit", limit)]);
        }
        if let Some(cursor) = &params.cursor {
            request = request.query(&[("cursor", cursor)]);
        }

        let response = self.send_with_rate_limit_retry(request).await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse TradeHistoryResponse: {}", e))
        })
    }

    /// Fetches PnL time-series data for an authority pubkey.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's authority pubkey
    /// * `params` - Query parameters including resolution, time range, and
    ///   limit
    ///
    /// Returns a vector of PnL data points.
    pub async fn get_pnl(
        &self,
        authority: &Pubkey,
        params: PnlQueryParams,
    ) -> Result<Vec<PnlPoint>, PhoenixHttpError> {
        self.get_pnl_internal(authority, params).await
    }

    async fn get_pnl_internal(
        &self,
        authority: &Pubkey,
        params: PnlQueryParams,
    ) -> Result<Vec<PnlPoint>, PhoenixHttpError> {
        let url = format!("{}/trader/{}/pnl", self.api_url, authority);

        let mut request = self
            .maybe_add_api_key(self.client.get(&url))
            .query(&[("resolution", params.resolution.to_string())]);

        if let Some(start_time) = params.start_time {
            request = request.query(&[("startTime", start_time)]);
        }
        if let Some(end_time) = params.end_time {
            request = request.query(&[("endTime", end_time)]);
        }
        if let Some(limit) = params.limit {
            request = request.query(&[("limit", limit)]);
        }

        let response = self.send_with_rate_limit_retry(request).await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            return Err(PhoenixHttpError::ApiError { status, message });
        }

        response.json().await.map_err(|e| {
            PhoenixHttpError::ParseFailed(format!("Failed to parse PnL response: {}", e))
        })
    }
}

fn parse_retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let client = PhoenixHttpClient::new("https://api.phoenix.trade/v1", "test-key");
        assert_eq!(client.api_url, "https://api.phoenix.trade/v1");
        assert_eq!(client.api_key.as_deref(), Some("test-key"));
        assert_eq!(client.rate_limit_retry, RateLimitRetryConfig::default());
    }

    #[test]
    fn test_client_with_string() {
        let url = String::from("https://api.example.com");
        let key = String::from("my-api-key");
        let client = PhoenixHttpClient::new(url, key);
        assert_eq!(client.api_url, "https://api.example.com");
        assert_eq!(client.api_key.as_deref(), Some("my-api-key"));
        assert_eq!(client.rate_limit_retry, RateLimitRetryConfig::default());
    }

    #[test]
    fn test_client_public() {
        let client = PhoenixHttpClient::new_public("https://api.example.com");
        assert_eq!(client.api_url, "https://api.example.com");
        assert!(client.api_key.is_none());
        assert_eq!(client.rate_limit_retry, RateLimitRetryConfig::default());
    }

    #[test]
    fn test_parse_retry_after_seconds() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(RETRY_AFTER, reqwest::header::HeaderValue::from_static("3"));
        assert_eq!(parse_retry_after_seconds(&headers), Some(3));

        headers.insert(RETRY_AFTER, reqwest::header::HeaderValue::from_static("0"));
        assert_eq!(parse_retry_after_seconds(&headers), Some(1));

        headers.insert(
            RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("not-a-number"),
        );
        assert_eq!(parse_retry_after_seconds(&headers), None);
    }
}
