use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};

use crate::error::AppError;
use crate::imperial::types::MarketEntry;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(list_markets))
}

/// GET /api/markets — aggregate per-venue market lists into one normalized
/// table. Each row is a (symbol, venue) pair; a single canonical symbol
/// can appear multiple times (e.g. SOL on Phoenix and Flash).
///
/// Resilient to per-venue failure: a transient upstream blip on one venue
/// logs a warning and yields an empty slice from that venue rather than
/// failing the whole request. Returns 502 only if *every* venue fails.
async fn list_markets(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<MarketEntry>>, AppError> {
    let (phoenix, flash, gmtrade) = tokio::join!(
        state.imperial.phoenix_markets(),
        state.imperial.flash_markets(),
        state.imperial.gmtrade_markets(),
    );
    let phoenix = phoenix.unwrap_or_else(|e| {
        tracing::warn!("phoenix_markets failed: {e}");
        Vec::new()
    });
    let flash = flash.unwrap_or_else(|e| {
        tracing::warn!("flash_markets failed: {e}");
        Vec::new()
    });
    let gmtrade = gmtrade.unwrap_or_else(|e| {
        tracing::warn!("gmtrade_markets failed: {e}");
        Vec::new()
    });
    if phoenix.is_empty() && flash.is_empty() && gmtrade.is_empty() {
        return Err(AppError::Imperial(
            "all three venue market endpoints failed".to_string(),
        ));
    }
    let mut out: Vec<MarketEntry> = Vec::new();
    for m in phoenix {
        out.push(MarketEntry {
            symbol: m.symbol,
            venue: "phoenix".to_string(),
            max_leverage: Some(m.max_leverage),
            isolated_only: true,
            status: "open".to_string(),
        });
    }
    for m in flash {
        let status = if m.allow_open_position { "open" } else { "closed" };
        out.push(MarketEntry {
            symbol: m.symbol,
            venue: "flash_trade".to_string(),
            max_leverage: m.max_leverage,
            isolated_only: true,
            status: status.to_string(),
        });
    }
    for m in gmtrade {
        out.push(MarketEntry {
            symbol: m.symbol,
            venue: "gmtrade".to_string(),
            max_leverage: None,
            isolated_only: true,
            status: if m.closed { "closed" } else { "open" }.to_string(),
        });
    }
    Ok(Json(out))
}
