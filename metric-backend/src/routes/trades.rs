use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::AppError;
use crate::imperial::types::PositionList;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/{wallet}", get(your_trades))
}

#[derive(Debug, Deserialize)]
pub struct TradesQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// GET /api/trades/:wallet — proxy to Imperial /trades.
///
/// Endpoint changed semantics during the Imperial swap. In Ember this
/// returned market-wide trade prints by symbol; Imperial has no public
/// trade-print stream, so this now returns the wallet's own position
/// lifecycles (open + closed). The frontend "Recent Trades" panel is
/// repurposed as "Your Trades".
async fn your_trades(
    Path(wallet): Path<String>,
    Query(q): Query<TradesQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PositionList>, AppError> {
    let list = state.imperial.trades(&wallet, q.limit, q.offset).await?;
    Ok(Json(list))
}
