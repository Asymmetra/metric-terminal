use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use phoenix_rise::PhoenixHttpError;
use serde::Deserialize;
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::AppState;

// Onboarding routes proxy Phoenix's /v1/invite/* endpoints.
//
// The Phoenix invite system is NOT an on-chain gate — any wallet can register,
// deposit, and trade without activating an invite. We enforce the gate at the
// UI layer: new wallets either activate (referral or access code) or browse
// the terminal in view-only mode.
//
// Per the SDK README, the two activation routes are NOT interchangeable:
//   /v1/invite/activate                — access code / allowlist code  (field: code)
//   /v1/invite/activate-with-referral  — referral code from another trader (field: referral_code)
// We expose one route each so callers explicitly pick which they have.

#[derive(Deserialize)]
pub struct ActivateReferralRequest {
    pub authority: String,
    pub referral_code: String,
}

#[derive(Deserialize)]
pub struct ActivateAccessCodeRequest {
    pub authority: String,
    pub code: String,
}

fn perp_api_url() -> String {
    std::env::var("PHOENIX_API_URL")
        .unwrap_or_else(|_| "https://perp-api.phoenix.trade".to_string())
}

/// Map a `Result<String, PhoenixHttpError>` from the SDK invite client into the
/// frontend's expected `{ trader_pda, already_activated }` shape, bucketing
/// errors as `invalid_code:...` or `upstream_error:...`.
fn map_activation_result(
    result: Result<String, PhoenixHttpError>,
) -> Result<Json<serde_json::Value>, AppError> {
    match result {
        Ok(trader_pda) => Ok(Json(serde_json::json!({
            "trader_pda": trader_pda,
            "already_activated": false,
        }))),
        Err(err) => {
            if let PhoenixHttpError::ApiError { status, message, .. } = &err {
                let msg_lower = message.to_lowercase();
                // "Already activated" / "already whitelisted" → success from the
                // user's POV. The frontend flips inviteActivated=true and closes
                // the modal so users who activated previously but never deposited
                // aren't blocked again on reconnect.
                if msg_lower.contains("already")
                    && (msg_lower.contains("activ") || msg_lower.contains("whitelist"))
                {
                    return Ok(Json(serde_json::json!({
                        "trader_pda": null,
                        "already_activated": true,
                    })));
                }
                // 400/404 + anything mentioning "invalid" → recoverable user error.
                if *status == 400 || *status == 404 || msg_lower.contains("invalid") {
                    return Err(AppError::BadRequest(format!("invalid_code:{}", message)));
                }
            }
            Err(AppError::Phoenix(format!("upstream_error:{err}")))
        }
    }
}

// POST /api/onboard/activate-referral
// Body: { authority, referral_code }
// Success: { trader_pda: "<pubkey>", already_activated: bool }
// Errors (as JSON { error, code }):
//   400 { code: "invalid_code" }   — Phoenix rejected the referral string
//   400 { code: "bad_authority" }  — authority isn't a valid pubkey
//   502 { code: "upstream_error" } — perp-api unreachable or 5xx
async fn activate_referral(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ActivateReferralRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&req.authority).map_err(|e| {
        AppError::BadRequest(format!("invalid_code:invalid authority pubkey: {e}"))
    })?;
    let code = req.referral_code.trim();
    if code.is_empty() {
        return Err(AppError::BadRequest(
            "invalid_code:referral_code is required".to_string(),
        ));
    }

    map_activation_result(
        state
            .http_client
            .invite()
            .activate_referral(&authority, code)
            .await,
    )
}

// POST /api/onboard/activate-access-code
// Body: { authority, code }
// Same response/error shape as activate_referral. Wraps Phoenix's
// /v1/invite/activate route (allowlist / access-code activation) which is
// distinct from the referral route per the rise-public SDK README.
async fn activate_access_code(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ActivateAccessCodeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let authority = Pubkey::from_str(&req.authority).map_err(|e| {
        AppError::BadRequest(format!("invalid_code:invalid authority pubkey: {e}"))
    })?;
    let code = req.code.trim();
    if code.is_empty() {
        return Err(AppError::BadRequest(
            "invalid_code:code is required".to_string(),
        ));
    }

    map_activation_result(
        state
            .http_client
            .invite()
            .activate_invite(&authority, code)
            .await,
    )
}

// GET /api/onboard/check/:pubkey
// Returns: { activated: bool, whitelisted_at: Option<String>, invite_code_used: Option<String> }
// Proxies GET /v1/invite/check/{wallet} on perp-api. The Rust SDK doesn't wrap
// this endpoint so we make the HTTP call directly.
async fn check_onboarding_status(
    State(_state): State<Arc<AppState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Validate pubkey format so we don't forward garbage to perp-api.
    let _ = Pubkey::from_str(&pubkey)
        .map_err(|e| AppError::BadRequest(format!("invalid authority pubkey: {e}")))?;

    let url = format!("{}/v1/invite/check/{}", perp_api_url(), pubkey);
    let resp = reqwest::get(&url).await.map_err(|e| {
        AppError::Phoenix(format!("perp-api check request failed: {e}"))
    })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        // 404 → wallet hasn't activated. Match the activated=false shape so the
        // frontend doesn't treat this as an error.
        if status == 404 {
            return Ok(Json(serde_json::json!({
                "activated": false,
                "whitelisted_at": null,
                "invite_code_used": null,
            })));
        }
        let msg = resp.text().await.unwrap_or_default();
        return Err(AppError::Phoenix(format!(
            "perp-api check returned {status}: {msg}"
        )));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| {
        AppError::Phoenix(format!("perp-api check bad json: {e}"))
    })?;

    let activated = body
        .get("whitelisted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let whitelisted_at = body
        .get("whitelisted_at")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let invite_code_used = body
        .get("invite_code_used")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Ok(Json(serde_json::json!({
        "activated": activated,
        "whitelisted_at": whitelisted_at,
        "invite_code_used": invite_code_used,
    })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/activate-referral", post(activate_referral))
        .route("/activate-access-code", post(activate_access_code))
        .route("/check/{pubkey}", get(check_onboarding_status))
}
