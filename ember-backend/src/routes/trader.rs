use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use phoenix_sdk::{
    CollateralHistoryQueryParams, FundingHistoryQueryParams, OrderHistoryQueryParams,
    PhoenixHttpError, PnlQueryParams, PnlResolution, TradeHistoryQueryParams,
};
use serde::Deserialize;
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::AppState;

/// GET /api/trader/:pubkey — Trader account overview (positions, margin, PnL)
async fn get_trader(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let mut traders = state
        .http_client
        .get_traders(&authority)
        .await
        .map_err(|e| match e {
            PhoenixHttpError::ApiError { status: 404, .. } => {
                AppError::NotFound(format!("No Phoenix account found for {}", pubkey))
            }
            _ => AppError::Phoenix(format!("Failed to fetch trader: {}", e)),
        })?;

    // Ensure cross-margin (subaccount 0) is always first; isolated follow in order.
    traders.sort_by_key(|t| t.trader_subaccount_index);

    Ok(Json(serde_json::json!({
        "authority": pubkey,
        "accounts": traders,
    })))
}

/// GET /api/trader/:pubkey/orders — Order history
async fn get_orders(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let params = OrderHistoryQueryParams::new(100);
    let response = state
        .http_client
        .get_order_history(&authority, params)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch order history: {}", e)))?;

    Ok(Json(serde_json::json!({
        "authority": pubkey,
        "orders": response.data,
        "has_more": response.has_more,
        "next_cursor": response.next_cursor,
    })))
}

/// GET /api/trader/:pubkey/trades — Trade history
async fn get_trades(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let params = TradeHistoryQueryParams::new().with_limit(100);
    let response = state
        .http_client
        .get_trade_history(&authority, params)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch trade history: {}", e)))?;

    Ok(Json(serde_json::json!({
        "authority": pubkey,
        "trades": response.data,
        "has_more": response.has_more,
        "next_cursor": response.next_cursor,
    })))
}

/// GET /api/trader/:pubkey/subaccounts — List all subaccounts (cross + isolated)
async fn get_subaccounts(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let traders = state
        .http_client
        .get_traders(&authority)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch subaccounts: {}", e)))?;

    Ok(Json(serde_json::json!({
        "authority": pubkey,
        "subaccounts": traders,
    })))
}

/// GET /api/trader/:pubkey/funding — Funding history
async fn get_funding(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let params = FundingHistoryQueryParams::new().with_limit(100);
    let response = state
        .http_client
        .get_funding_history(&authority, params)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch funding history: {}", e)))?;

    Ok(Json(serde_json::json!({
        "authority": pubkey,
        "funding": response,
    })))
}

#[derive(Deserialize)]
pub struct PnlQuery {
    pub resolution: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct CollateralHistoryQuery {
    pub limit: Option<i64>,
}

/// GET /api/trader/:pubkey/pnl — PnL time-series
async fn get_pnl(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
    Query(query): Query<PnlQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let resolution_str = query.resolution.unwrap_or_else(|| "1h".to_string());
    let resolution = PnlResolution::from_str(&resolution_str)
        .map_err(|e| AppError::BadRequest(format!("Invalid resolution: {}", e)))?;

    let limit = query.limit.unwrap_or(168).min(1000);

    let params = PnlQueryParams::new(resolution).with_limit(limit);
    let pnl = state
        .http_client
        .get_pnl(&authority, params)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch PnL: {}", e)))?;

    Ok(Json(serde_json::json!({
        "authority": pubkey,
        "resolution": resolution_str,
        "data": pnl,
    })))
}

/// GET /api/trader/:pubkey/collateral-history — Deposit/withdraw events
async fn get_collateral_history(
    State(state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
    Query(query): Query<CollateralHistoryQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let limit = query.limit.unwrap_or(100).min(1000);

    let params = CollateralHistoryQueryParams::new(limit);
    let response = state
        .http_client
        .get_collateral_history(&authority, params)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch collateral history: {}", e)))?;

    Ok(Json(serde_json::json!({
        "authority": pubkey,
        "data": response.data,
        "has_more": response.has_more,
        "next_cursor": response.next_cursor,
    })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{pubkey}", get(get_trader))
        .route("/{pubkey}/orders", get(get_orders))
        .route("/{pubkey}/trades", get(get_trades))
        .route("/{pubkey}/subaccounts", get(get_subaccounts))
        .route("/{pubkey}/funding", get(get_funding))
        .route("/{pubkey}/pnl", get(get_pnl))
        .route("/{pubkey}/collateral-history", get(get_collateral_history))
}
