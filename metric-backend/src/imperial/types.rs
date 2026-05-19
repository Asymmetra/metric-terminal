//! Imperial Trading API DTOs (subset used by the backend).
//!
//! Names mirror the OpenAPI shapes verbatim (camelCase) so future code
//! generation can replace this file with no call-site churn.

use serde::{Deserialize, Serialize};

// ────────────────────────────────────────────── reads: mark prices, funding

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkPriceList {
    pub rows: Vec<MarkPriceRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkPriceRow {
    pub symbol: String,
    pub jupiter: Option<VenueMarkPrice>,
    pub flash: Option<VenueMarkPrice>,
    pub phoenix: Option<VenueMarkPrice>,
    pub gmtrade: Option<VenueMarkPrice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VenueMarkPrice {
    pub price: f64,
    pub source: String,
    #[serde(rename = "fetchedAtUnixMs")]
    pub fetched_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FundingRatesList {
    pub rows: Vec<FundingRateRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FundingRateRow {
    pub symbol: String,
    pub jupiter: Option<VenueFundingRate>,
    pub flash: Option<VenueFundingRate>,
    pub phoenix: Option<VenueFundingRate>,
    pub gmtrade: Option<VenueFundingRate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VenueFundingRate {
    pub source: String,
    #[serde(rename = "longFundingRatePerHourPercent")]
    pub long_funding_rate_per_hour_percent: Option<f64>,
    #[serde(rename = "shortFundingRatePerHourPercent")]
    pub short_funding_rate_per_hour_percent: Option<f64>,
    #[serde(rename = "longBorrowRatePerHourPercent")]
    pub long_borrow_rate_per_hour_percent: Option<f64>,
    #[serde(rename = "shortBorrowRatePerHourPercent")]
    pub short_borrow_rate_per_hour_percent: Option<f64>,
}

// ────────────────────────────────────────────── per-venue market lists

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoenixMarket {
    pub symbol: String,
    #[serde(rename = "assetId")]
    pub asset_id: i64,
    pub underwriter: String,
    #[serde(rename = "subaccountIndex")]
    pub subaccount_index: i32,
    #[serde(rename = "maxLeverage")]
    pub max_leverage: f64,
    #[serde(rename = "tickSizeInQuoteLotsPerBaseLot")]
    pub tick_size_in_quote_lots_per_base_lot: i64,
    #[serde(rename = "makerFeeMicro")]
    pub maker_fee_micro: i32,
    #[serde(rename = "takerFeeMicro")]
    pub taker_fee_micro: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashMarket {
    pub symbol: String,
    pub underwriter: String,
    pub side: String,
    #[serde(rename = "maxLeverage")]
    pub max_leverage: Option<f64>,
    #[serde(rename = "allowOpenPosition")]
    pub allow_open_position: bool,
    #[serde(rename = "allowClosePosition")]
    pub allow_close_position: bool,
    #[serde(rename = "tokenDecimals")]
    pub token_decimals: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GmtradeMarket {
    pub symbol: String,
    pub underwriter: String,
    pub closed: bool,
    #[serde(rename = "indexTokenDecimals")]
    pub index_token_decimals: i32,
}

// ────────────────────────────────────────────── normalized market shape

/// A market row served by GET /api/markets. Aggregates per-venue lists
/// and tags each row with its underwriter so the order-entry UI can
/// route. Same canonical symbol can appear multiple times across venues.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketEntry {
    pub symbol: String,
    pub venue: String,
    #[serde(rename = "maxLeverage")]
    pub max_leverage: Option<f64>,
    #[serde(rename = "isolatedOnly")]
    pub isolated_only: bool,
    pub status: String,
}

// ────────────────────────────────────────────── deposit/withdraw

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositRequest {
    pub wallet: String,
    #[serde(rename = "profileIndex")]
    pub profile_index: i32,
    pub amount: i64,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositResponse {
    /// Base64 partially-signed VersionedTransaction.
    pub transaction: String,
}

// ────────────────────────────────────────────── positions/trades

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionList {
    pub count: i32,
    #[serde(rename = "totalCount")]
    pub total_count: i64,
    #[serde(rename = "dataList")]
    pub data_list: Vec<serde_json::Value>,
    #[serde(rename = "lifetimePnlUsd")]
    pub lifetime_pnl_usd: String,
    #[serde(rename = "lifetimeFeesUsd")]
    pub lifetime_fees_usd: String,
    #[serde(rename = "lifetimeCollateralUsd")]
    pub lifetime_collateral_usd: String,
}

// ────────────────────────────────────────────── phoenix depth

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoenixDepth {
    pub snapshots: serde_json::Value,
}

// ────────────────────────────────────────────── route

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteQuery {
    pub asset: String,
    pub side: String, // "long" | "short"
    pub notional: f64,
    #[serde(rename = "desiredLeverage")]
    pub desired_leverage: f64,
    pub wallet: Option<String>,
    #[serde(rename = "profileIndex")]
    pub profile_index: Option<i32>,
}
