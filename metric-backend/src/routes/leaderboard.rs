use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use phoenix_rise::{PnlQueryParams, PnlResolution};
use serde::Deserialize;
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;
use crate::state::AppState;

#[derive(Deserialize)]
struct RegisterBody {
    authority: String,
}

/// POST /api/leaderboard/register — Register a trader for leaderboard tracking.
async fn register(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _ = Pubkey::from_str(&body.authority)
        .map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))?;

    let is_new = state.known_traders.insert(body.authority.clone());

    // Persist to disk if this is a new trader
    if is_new {
        let traders: Vec<String> = state.known_traders.iter().map(|r| r.clone()).collect();
        if let Ok(json) = serde_json::to_string_pretty(&traders) {
            if let Err(e) = std::fs::write("known_traders.json", json) {
                tracing::warn!("Failed to persist known_traders.json: {}", e);
            }
        }
    }

    Ok(Json(serde_json::json!({
        "registered": true,
        "authority": body.authority,
        "total_traders": state.known_traders.len(),
    })))
}

#[derive(Deserialize)]
struct LeaderboardQuery {
    period: Option<String>,
    limit: Option<usize>,
}

/// GET /api/leaderboard — Get leaderboard rankings sorted by PnL.
async fn get_leaderboard(
    State(state): State<Arc<AppState>>,
    Query(query): Query<LeaderboardQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let period = query.period.unwrap_or_else(|| "1d".to_string());
    let limit = query.limit.unwrap_or(50).min(100);

    // Check cache (5 minute TTL)
    {
        let cache = state.leaderboard_cache.read().await;
        if let Some(ref snapshot) = *cache {
            let now_secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let age_secs = now_secs - snapshot.computed_at;
            if age_secs < 300 && snapshot.period == period {
                let end = limit.min(snapshot.entries.len());
                return Ok(Json(serde_json::json!({
                    "period": period,
                    "traders": &snapshot.entries[..end],
                    "total_registered": state.known_traders.len(),
                    "cached": true,
                    "cache_age_secs": age_secs,
                })));
            }
        }
    }

    // Collect known traders
    let traders: Vec<String> = state.known_traders.iter().map(|r| r.clone()).collect();

    if traders.is_empty() {
        return Ok(Json(serde_json::json!({
            "period": period,
            "traders": [],
            "total_registered": 0,
            "cached": false,
        })));
    }

    // Map period to PnL resolution + limit
    let (res_str, pnl_limit) = match period.as_str() {
        "1d" => ("1h", 24i64),
        "1w" => ("1h", 168i64),
        "1m" => ("1d", 30i64),
        _ => ("1d", 1000i64), // "all"
    };

    let resolution = PnlResolution::from_str(res_str)
        .map_err(|e| AppError::BadRequest(format!("Invalid resolution: {}", e)))?;

    // Fetch PnL for each trader (sequential — fine for small trader counts)
    let mut entries = Vec::new();

    for pubkey_str in &traders {
        let authority = match Pubkey::from_str(pubkey_str) {
            Ok(pk) => pk,
            Err(_) => continue,
        };

        let params = PnlQueryParams::new(resolution).with_limit(pnl_limit);
        match state.http_client.traders().get_trader_pnl(&authority, params).await {
            Ok(pnl_data) => {
                let data = serde_json::to_value(&pnl_data).unwrap_or_default();
                let points = data.as_array().cloned().unwrap_or_default();

                // Phoenix's `cumulative_pnl` is **already net of fees and funding**
                // (it represents realized PnL net of all costs). Subtracting fees
                // a second time on the client would double-count, so we surface a
                // single `net_pnl` field. We keep `gross_fees` (taker + maker, the
                // SDK exposes them separately) and `cumulative_funding` for
                // attribution / display, but they are NOT to be re-applied to the
                // headline number.
                if let Some(last) = points.last() {
                    let last_cum_pnl = last
                        .get("cumulative_pnl")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let last_taker = last.get("cumulative_taker_fee").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let last_maker = last.get("cumulative_maker_fee").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let last_funding = last.get("cumulative_funding_payment").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let first_cum_pnl = points
                        .first()
                        .and_then(|p| p.get("cumulative_pnl"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let first_taker = points.first().and_then(|p| p.get("cumulative_taker_fee")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let first_maker = points.first().and_then(|p| p.get("cumulative_maker_fee")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let first_funding = points.first().and_then(|p| p.get("cumulative_funding_payment")).and_then(|v| v.as_f64()).unwrap_or(0.0);

                    let period_net_pnl = last_cum_pnl - first_cum_pnl;
                    let period_fees = (last_taker - first_taker) + (last_maker - first_maker);
                    let period_funding = last_funding - first_funding;

                    entries.push(serde_json::json!({
                        "authority": pubkey_str,
                        // Net PnL over the period (already net of fees + funding).
                        // The `pnl` field is kept as an alias for short-term
                        // backward compat with older frontend builds and will be
                        // removed once the rename is fully rolled out.
                        "net_pnl": period_net_pnl,
                        "pnl": period_net_pnl,
                        "cumulative_pnl": last_cum_pnl,
                        "gross_fees": period_fees,
                        "cumulative_funding": period_funding,
                        // Keep `fees` as alias for the same reason as `pnl` above.
                        "fees": period_fees,
                    }));
                } else {
                    // PnL returned OK but no data points — include trader with zero values
                    entries.push(serde_json::json!({
                        "authority": pubkey_str,
                        "net_pnl": 0.0,
                        "pnl": 0.0,
                        "cumulative_pnl": 0.0,
                        "gross_fees": 0.0,
                        "cumulative_funding": 0.0,
                        "fees": 0.0,
                    }));
                }
            }
            Err(e) => {
                tracing::warn!("Leaderboard: failed to fetch PnL for {}: {}", pubkey_str, e);
                // Still include the trader so they appear on the leaderboard
                entries.push(serde_json::json!({
                    "authority": pubkey_str,
                    "net_pnl": 0.0,
                    "pnl": 0.0,
                    "cumulative_pnl": 0.0,
                    "gross_fees": 0.0,
                    "cumulative_funding": 0.0,
                    "fees": 0.0,
                }));
            }
        }
    }

    // Sort by period PnL descending
    entries.sort_by(|a, b| {
        // Sort by net_pnl (the new canonical field). Falls back to legacy
        // `pnl` alias for any old shape that may still surface.
        let a_pnl = a
            .get("net_pnl")
            .or_else(|| a.get("pnl"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let b_pnl = b
            .get("net_pnl")
            .or_else(|| b.get("pnl"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        b_pnl
            .partial_cmp(&a_pnl)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Cache the result
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    {
        let mut cache = state.leaderboard_cache.write().await;
        *cache = Some(crate::state::LeaderboardSnapshot {
            period: period.clone(),
            entries: entries.clone(),
            computed_at: now,
        });
    }

    let end = limit.min(entries.len());

    Ok(Json(serde_json::json!({
        "period": period,
        "traders": &entries[..end],
        "total_registered": state.known_traders.len(),
        "cached": false,
    })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/register", post(register))
        .route("/", get(get_leaderboard))
}
