use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use phoenix_sdk::{CancelId, PhoenixTxBuilder, Side, TraderKey};
use serde::Deserialize;
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;

use crate::error::AppError;
use crate::services::tx_builder::{serialize_instructions, TxResponse};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct MarketOrderRequest {
    pub authority: String,
    pub symbol: String,
    pub side: String,
    pub size_lots: u64,
}

#[derive(Deserialize)]
pub struct LimitOrderRequest {
    pub authority: String,
    pub symbol: String,
    pub side: String,
    pub price: f64,
    pub size_lots: u64,
}

#[derive(Deserialize)]
pub struct CancelOrderId {
    pub price_in_ticks: u64,
    pub order_sequence_number: u64,
}

#[derive(Deserialize)]
pub struct CancelOrdersRequest {
    pub authority: String,
    pub symbol: String,
    pub order_ids: Vec<CancelOrderId>,
}

#[derive(Deserialize)]
pub struct DepositRequest {
    pub authority: String,
    pub amount_usdc: f64,
}

#[derive(Deserialize)]
pub struct WithdrawRequest {
    pub authority: String,
    pub amount_usdc: f64,
}

fn parse_side(s: &str) -> Result<Side, AppError> {
    match s.to_lowercase().as_str() {
        "bid" | "buy" | "long" => Ok(Side::Bid),
        "ask" | "sell" | "short" => Ok(Side::Ask),
        _ => Err(AppError::BadRequest(format!(
            "Invalid side: {}. Use bid/buy/long or ask/sell/short",
            s
        ))),
    }
}

fn parse_authority(s: &str) -> Result<Pubkey, AppError> {
    Pubkey::from_str(s).map_err(|e| AppError::BadRequest(format!("Invalid pubkey: {}", e)))
}

fn validate_size_lots(size: u64) -> Result<(), AppError> {
    if size == 0 {
        return Err(AppError::BadRequest(
            "size_lots must be greater than 0".to_string(),
        ));
    }
    Ok(())
}

fn validate_price(price: f64) -> Result<(), AppError> {
    if price <= 0.0 || !price.is_finite() {
        return Err(AppError::BadRequest(
            "price must be a positive finite number".to_string(),
        ));
    }
    Ok(())
}

fn validate_amount(amount: f64) -> Result<(), AppError> {
    if amount <= 0.0 || !amount.is_finite() {
        return Err(AppError::BadRequest(
            "amount_usdc must be a positive finite number".to_string(),
        ));
    }
    Ok(())
}

async fn market_order(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MarketOrderRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building market order: {} {} lots on {}",
        req.side,
        req.size_lots,
        req.symbol
    );

    validate_size_lots(req.size_lots)?;
    let authority = parse_authority(&req.authority)?;
    let side = parse_side(&req.side)?;
    let trader_pda = TraderKey::derive_pda(&authority, 0, 0);

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let instructions = builder
        .build_market_order(authority, trader_pda, &req.symbol, side, req.size_lots)
        .map_err(|e| AppError::Phoenix(format!("Failed to build market order: {}", e)))?;

    Ok(Json(serialize_instructions(
        instructions,
        format!(
            "Market {} order: {} lots on {}",
            req.side, req.size_lots, req.symbol
        ),
    )))
}

async fn limit_order(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LimitOrderRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building limit order: {} {} lots at ${} on {}",
        req.side,
        req.size_lots,
        req.price,
        req.symbol
    );

    validate_size_lots(req.size_lots)?;
    validate_price(req.price)?;
    let authority = parse_authority(&req.authority)?;
    let side = parse_side(&req.side)?;
    let trader_pda = TraderKey::derive_pda(&authority, 0, 0);

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let instructions = builder
        .build_limit_order(
            authority,
            trader_pda,
            &req.symbol,
            side,
            req.price,
            req.size_lots,
        )
        .map_err(|e| AppError::Phoenix(format!("Failed to build limit order: {}", e)))?;

    Ok(Json(serialize_instructions(
        instructions,
        format!(
            "Limit {} order: {} lots at ${} on {}",
            req.side, req.size_lots, req.price, req.symbol
        ),
    )))
}

async fn cancel_orders(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CancelOrdersRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building cancel: {} orders on {}",
        req.order_ids.len(),
        req.symbol
    );

    if req.order_ids.is_empty() {
        return Err(AppError::BadRequest(
            "order_ids cannot be empty".to_string(),
        ));
    }
    let authority = parse_authority(&req.authority)?;
    let trader_pda = TraderKey::derive_pda(&authority, 0, 0);

    let order_ids: Vec<CancelId> = req
        .order_ids
        .iter()
        .map(|id| CancelId::new(id.price_in_ticks, id.order_sequence_number))
        .collect();

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let instructions = builder
        .build_cancel_orders(authority, trader_pda, &req.symbol, order_ids)
        .map_err(|e| AppError::Phoenix(format!("Failed to build cancel orders: {}", e)))?;

    Ok(Json(serialize_instructions(
        instructions,
        format!("Cancel {} orders on {}", req.order_ids.len(), req.symbol),
    )))
}

async fn deposit(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DepositRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!("Building deposit: {} USDC", req.amount_usdc);
    validate_amount(req.amount_usdc)?;

    let authority = parse_authority(&req.authority)?;
    let trader_pda = TraderKey::derive_pda(&authority, 0, 0);

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let instructions = builder
        .build_deposit_funds(authority, trader_pda, req.amount_usdc)
        .map_err(|e| AppError::Phoenix(format!("Failed to build deposit: {}", e)))?;

    Ok(Json(serialize_instructions(
        instructions,
        format!("Deposit {} USDC", req.amount_usdc),
    )))
}

async fn withdraw(
    State(state): State<Arc<AppState>>,
    Json(req): Json<WithdrawRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!("Building withdraw: {} USDC", req.amount_usdc);
    validate_amount(req.amount_usdc)?;

    let authority = parse_authority(&req.authority)?;
    let trader_pda = TraderKey::derive_pda(&authority, 0, 0);

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let instructions = builder
        .build_withdraw_funds(authority, trader_pda, req.amount_usdc)
        .map_err(|e| AppError::Phoenix(format!("Failed to build withdrawal: {}", e)))?;

    Ok(Json(serialize_instructions(
        instructions,
        format!("Withdraw {} USDC", req.amount_usdc),
    )))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/market-order", post(market_order))
        .route("/limit-order", post(limit_order))
        .route("/cancel-orders", post(cancel_orders))
        .route("/deposit", post(deposit))
        .route("/withdraw", post(withdraw))
}
