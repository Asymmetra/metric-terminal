use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use phoenix_sdk::{FundingHistoryQueryParams, OrderHistoryQueryParams, TradeHistoryQueryParams};
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

    let traders = state
        .http_client
        .get_traders(&authority)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch trader: {}", e)))?;

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

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{pubkey}", get(get_trader))
        .route("/{pubkey}/orders", get(get_orders))
        .route("/{pubkey}/trades", get(get_trades))
        .route("/{pubkey}/funding", get(get_funding))
}
