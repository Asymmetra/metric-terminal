use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};

use crate::error::AppError;
use crate::imperial::types::PositionList;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{wallet}", get(positions))
        .route("/{wallet}/positions", get(positions))
        .route("/{wallet}/trades", get(trades))
}

/// GET /api/trader/:wallet — open position lifecycles (Imperial /positions).
async fn positions(
    Path(wallet): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PositionList>, AppError> {
    Ok(Json(state.imperial.positions(&wallet).await?))
}

/// GET /api/trader/:wallet/trades — historical lifecycles (Imperial /trades).
async fn trades(
    Path(wallet): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PositionList>, AppError> {
    Ok(Json(state.imperial.trades(&wallet, None, None).await?))
}
