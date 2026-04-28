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
// UI layer: new wallets must either activate with a referral code or choose
// "view only" (which disconnects the wallet). These routes just let the
// frontend ask Phoenix "is this wallet activated?" and "activate this wallet
// with this code."

#[derive(Deserialize)]
pub struct ActivateReferralRequest {
    pub authority: String,
    pub referral_code: String,
}

fn perp_api_url() -> String {
    std::env::var("PHOENIX_API_URL")
        .unwrap_or_else(|_| "https://perp-api.phoenix.trade".to_string())
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

    match state.http_client.invite().activate_referral(&authority, code).await {
        Ok(body) => {
            // SDK returns the response body as a String; parse out trader_pda if present.
            let trader_pda = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("trader_pda").and_then(|t| t.as_str()).map(str::to_string));
            Ok(Json(serde_json::json!({
                "trader_pda": trader_pda,
                "already_activated": false,
            })))
        }
        Err(err) => {
            // Phoenix returns non-2xx bodies with varying error shapes. We look
            // at status + message to bucket the error into invalid_code or
            // already_activated; anything else becomes upstream_error.
            if let PhoenixHttpError::ApiError { status, message, .. } = &err {
                let msg_lower = message.to_lowercase();
                if msg_lower.contains("already") && (msg_lower.contains("activ") || msg_lower.contains("whitelist")) {
                    // Treat already-activated as success from the caller's POV —
                    // the frontend will flip inviteActivated=true and close the modal.
                    return Ok(Json(serde_json::json!({
                        "trader_pda": null,
                        "already_activated": true,
                    })));
                }
                if *status == 400 || *status == 404 || msg_lower.contains("invalid") {
                    return Err(AppError::BadRequest(format!(
                        "invalid_code:{}",
                        message
                    )));
                }
            }
            Err(AppError::Phoenix(format!("upstream_error:{err}")))
        }
    }
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
        // If perp-api returns 404, treat as "not activated" — this matches
        // the shape the frontend expects and avoids showing an error state.
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
        .route("/check/{pubkey}", get(check_onboarding_status))
}
