use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::Value;

use crate::error::AppError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/{symbol}", get(get_orderbook))
}

/// GET /api/orderbook/:symbol — proxy Imperial /phoenix/depth. Only Phoenix
/// has an orderbook; AMM venues (Jupiter, Flash, GMTrade) return null.
async fn get_orderbook(
    Path(symbol): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, AppError> {
    let depth = state.imperial.phoenix_depth().await?;
    let symbol_upper = symbol.to_uppercase();
    if let Some(obj) = depth.snapshots.as_object() {
        for (key, val) in obj {
            let k = key.to_uppercase();
            if k == symbol_upper || k == symbol_upper.replace("-PERP", "") {
                return Ok(Json(val.clone()));
            }
        }
    }
    Ok(Json(Value::Null))
}
