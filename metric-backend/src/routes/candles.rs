use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::AppError;
use crate::imperial::candles::{Candle, Timeframe};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/{symbol}", get(get_candles))
}

#[derive(Debug, Deserialize)]
pub struct CandleQuery {
    /// "1m" | "5m" | "15m" | "1h" — defaults to "1m".
    pub timeframe: Option<String>,
    /// Maximum number of bars to return (default 200).
    pub limit: Option<usize>,
    /// Which venue's price series. Defaults to "phoenix".
    pub venue: Option<String>,
}

/// GET /api/candles/:symbol — served from the in-process CandleAggregator
/// fed by the Imperial mark-price WS stream. Cold start is empty; bars
/// fill in as the stream runs.
async fn get_candles(
    Path(symbol): Path<String>,
    Query(q): Query<CandleQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Candle>>, AppError> {
    let tf = q
        .timeframe
        .as_deref()
        .and_then(Timeframe::from_str)
        .unwrap_or(Timeframe::M1);
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let venue = q.venue.unwrap_or_else(|| "phoenix".to_string());
    let bars = state.candles.get(&venue, &symbol, tf, limit);
    Ok(Json(bars))
}
