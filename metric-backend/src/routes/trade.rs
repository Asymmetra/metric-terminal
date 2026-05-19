//! Tx-building endpoints.
//!
//! After the Imperial swap, this file only handles **deposit/withdraw**
//! because Imperial's /deposit/build-tx returns an unsigned partially-
//! signed VersionedTransaction we can pass through to the client signer
//! (Phantom in the PoC, Privy+paymaster in production).
//!
//! Order placement / cancel / update / collateral are JWT-delegated on
//! Imperial. The frontend calls those endpoints directly (browser →
//! api.imperial.space/api/v1/mobile/*) so this backend never holds a
//! per-wallet JWT.
//!
//! Stubs for the legacy Ember POST endpoints return 410 Gone with a
//! redirect hint so any stale client surface is loud rather than silent.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::AppError;
use crate::imperial::types::{DepositRequest, DepositResponse};
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/deposit", post(deposit))
        .route("/withdraw", post(withdraw))
        .route("/market-order", post(gone_call_imperial))
        .route("/limit-order", post(gone_call_imperial))
        .route("/cancel-orders", post(gone_call_imperial))
        .route("/isolated-market-order", post(gone_call_imperial))
        .route("/isolated-limit-order", post(gone_call_imperial))
        .route("/transfer-collateral", post(gone_transfer))
        .route("/register-subaccount", post(gone_call_imperial))
        .route("/place-multi-limit-orders", post(gone_call_imperial))
        .route("/cancel-stop-loss", post(gone_call_imperial))
        .route("/close-all-positions", post(gone_call_imperial))
}

#[derive(Debug, Deserialize)]
pub struct DepositBody {
    pub wallet: String,
    #[serde(default)]
    pub profile_index: i32,
    /// USDC amount in native 6-decimal units (1_000_000 = $1).
    pub amount: i64,
}

/// POST /api/tx/deposit — proxies Imperial /deposit/build-tx with
/// mode="deposit". Returns the base64 partially-signed VersionedTransaction
/// for the client signer to finalize.
async fn deposit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DepositBody>,
) -> Result<Json<DepositResponse>, AppError> {
    validate_pubkey(&body.wallet)?;
    let req = DepositRequest {
        wallet: body.wallet,
        profile_index: body.profile_index,
        amount: body.amount,
        mode: "deposit".to_string(),
    };
    Ok(Json(state.imperial.build_deposit_tx(&req).await?))
}

/// POST /api/tx/withdraw — proxies /deposit/build-tx with mode="withdraw".
async fn withdraw(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DepositBody>,
) -> Result<Json<DepositResponse>, AppError> {
    validate_pubkey(&body.wallet)?;
    let req = DepositRequest {
        wallet: body.wallet,
        profile_index: body.profile_index,
        amount: body.amount,
        mode: "withdraw".to_string(),
    };
    Ok(Json(state.imperial.build_deposit_tx(&req).await?))
}

async fn gone_call_imperial() -> Result<Json<()>, AppError> {
    Err(AppError::Gone(
        "Order/cancel/etc. require a per-wallet Imperial JWT. Call \
         https://api.imperial.space/api/v1/mobile/* directly from the \
         signed-in client (see metric-frontend/src/lib/imperial/client.ts)."
            .to_string(),
    ))
}

async fn gone_transfer() -> Result<Json<()>, AppError> {
    Err(AppError::Gone(
        "Inter-profile collateral transfer is not an Imperial primitive. \
         Use withdraw → deposit on the two profile indices."
            .to_string(),
    ))
}

fn validate_pubkey(s: &str) -> Result<(), AppError> {
    use std::str::FromStr;
    solana_pubkey::Pubkey::from_str(s)
        .map(|_| ())
        .map_err(|e| AppError::BadRequest(format!("invalid wallet pubkey: {e}")))
}
