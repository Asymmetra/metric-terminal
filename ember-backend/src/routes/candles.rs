use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use phoenix_sdk::{CandlesQueryParams, Timeframe};
use serde::Deserialize;
use std::str::FromStr;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CandleQuery {
    pub timeframe: Option<String>,
    pub limit: Option<u32>,
}

async fn get_candles(
    State(state): State<Arc<AppState>>,
    Path(symbol): Path<String>,
    Query(query): Query<CandleQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let tf_str = query
        .timeframe
        .unwrap_or_else(|| "1m".to_string())
        .to_lowercase();
    let limit = query.limit.unwrap_or(300).min(1000);

    let timeframe = Timeframe::from_str(&tf_str)
        .map_err(|e| AppError::BadRequest(format!("Invalid timeframe: {}", e)))?;

    let params = CandlesQueryParams::new(&symbol, timeframe).with_limit(limit);

    let candles = state
        .http_client
        .get_candles(params)
        .await
        .map_err(|e| AppError::Phoenix(format!("Failed to fetch candles: {}", e)))?;

    Ok(Json(serde_json::json!(candles)))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/{symbol}", get(get_candles))
}
