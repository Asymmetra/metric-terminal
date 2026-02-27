use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use phoenix_sdk::{BracketLegOrders, CancelId, IsolatedCollateralFlow, PhoenixTxBuilder, Side, TraderKey};
use serde::Deserialize;
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;

use crate::error::AppError;
use crate::services::tx_builder::{serialize_instructions, TxResponse};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct MarketOrderRequest {
    pub authority: String,
    pub symbol: String,
    pub side: String,
    pub size_lots: u64,
    #[serde(default)]
    pub stop_loss_price: Option<f64>,
    #[serde(default)]
    pub take_profit_price: Option<f64>,
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

#[derive(Deserialize)]
pub struct IsolatedMarketOrderRequest {
    pub authority: String,
    pub symbol: String,
    pub side: String,
    pub size_lots: u64,
    /// Desired USDC collateral level in the isolated subaccount.
    /// Delta above existing collateral is transferred from cross-margin.
    #[serde(default)]
    pub collateral_usdc: Option<f64>,
    #[serde(default)]
    pub allow_cross_and_isolated: Option<bool>,
    #[serde(default)]
    pub stop_loss_price: Option<f64>,
    #[serde(default)]
    pub take_profit_price: Option<f64>,
}

#[derive(Deserialize)]
pub struct IsolatedLimitOrderRequest {
    pub authority: String,
    pub symbol: String,
    pub side: String,
    pub price: f64,
    pub size_lots: u64,
    #[serde(default)]
    pub collateral_usdc: Option<f64>,
    #[serde(default)]
    pub allow_cross_and_isolated: Option<bool>,
}

#[derive(Deserialize)]
pub struct TransferCollateralRequest {
    pub authority: String,
    pub from_subaccount_index: u8,
    pub to_subaccount_index: u8,
    /// USDC amount to transfer. Omit to sweep all collateral (child→parent only).
    #[serde(default)]
    pub amount_usdc: Option<f64>,
}

#[derive(Deserialize)]
pub struct RegisterSubaccountRequest {
    pub authority: String,
    /// Isolated subaccount index (1–100).
    pub subaccount_index: u8,
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

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

fn validate_subaccount_index(index: u8) -> Result<(), AppError> {
    if index == 0 || index > 100 {
        return Err(AppError::BadRequest(
            "subaccount_index must be between 1 and 100".to_string(),
        ));
    }
    Ok(())
}

fn build_bracket(
    stop_loss_price: Option<f64>,
    take_profit_price: Option<f64>,
) -> Result<Option<BracketLegOrders>, AppError> {
    if let Some(p) = stop_loss_price {
        if p <= 0.0 || !p.is_finite() {
            return Err(AppError::BadRequest(
                "stop_loss_price must be a positive finite number".to_string(),
            ));
        }
    }
    if let Some(p) = take_profit_price {
        if p <= 0.0 || !p.is_finite() {
            return Err(AppError::BadRequest(
                "take_profit_price must be a positive finite number".to_string(),
            ));
        }
    }
    if stop_loss_price.is_some() || take_profit_price.is_some() {
        Ok(Some(BracketLegOrders {
            stop_loss_price,
            take_profit_price,
        }))
    } else {
        Ok(None)
    }
}

fn build_collateral(collateral_usdc: Option<f64>) -> Result<Option<IsolatedCollateralFlow>, AppError> {
    match collateral_usdc {
        Some(usdc) => {
            if usdc <= 0.0 || !usdc.is_finite() {
                return Err(AppError::BadRequest(
                    "collateral_usdc must be a positive finite number".to_string(),
                ));
            }
            // Cap at u64::MAX / 1_000_000 to prevent overflow on f64→u64 cast
            if usdc > 1e13 {
                return Err(AppError::BadRequest(
                    "collateral_usdc exceeds maximum allowed value".to_string(),
                ));
            }
            Ok(Some(IsolatedCollateralFlow::TransferFromCrossMargin {
                collateral: (usdc * 1_000_000.0) as u64,
            }))
        }
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Cross-margin handlers (existing)
// ---------------------------------------------------------------------------

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
    let bracket = build_bracket(req.stop_loss_price, req.take_profit_price)?;

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let instructions = builder
        .build_market_order(
            authority,
            trader_pda,
            &req.symbol,
            side,
            req.size_lots,
            bracket.as_ref(),
        )
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

// ---------------------------------------------------------------------------
// Isolated margin handlers (new)
// ---------------------------------------------------------------------------

async fn isolated_market_order(
    State(state): State<Arc<AppState>>,
    Json(req): Json<IsolatedMarketOrderRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building isolated market order: {} {} lots on {}",
        req.side,
        req.size_lots,
        req.symbol
    );

    validate_size_lots(req.size_lots)?;
    let authority = parse_authority(&req.authority)?;
    let side = parse_side(&req.side)?;
    let collateral = build_collateral(req.collateral_usdc)?;
    let bracket = build_bracket(req.stop_loss_price, req.take_profit_price)?;
    let allow_cross_and_isolated = req.allow_cross_and_isolated.unwrap_or(false);

    let instructions = state
        .http_client
        .build_isolated_market_order_tx(
            &authority,
            &req.symbol,
            side,
            req.size_lots,
            collateral,
            allow_cross_and_isolated,
            bracket.as_ref(),
        )
        .await
        .map_err(|e| {
            AppError::Phoenix(format!("Failed to build isolated market order: {}", e))
        })?;

    Ok(Json(serialize_instructions(
        instructions,
        format!(
            "Isolated market {} order: {} lots on {}",
            req.side, req.size_lots, req.symbol
        ),
    )))
}

async fn isolated_limit_order(
    State(state): State<Arc<AppState>>,
    Json(req): Json<IsolatedLimitOrderRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building isolated limit order: {} {} lots at ${} on {}",
        req.side,
        req.size_lots,
        req.price,
        req.symbol
    );

    validate_size_lots(req.size_lots)?;
    validate_price(req.price)?;
    let authority = parse_authority(&req.authority)?;
    let side = parse_side(&req.side)?;
    let collateral = build_collateral(req.collateral_usdc)?;
    let allow_cross_and_isolated = req.allow_cross_and_isolated.unwrap_or(false);

    let instructions = state
        .http_client
        .build_isolated_limit_order_tx(
            &authority,
            &req.symbol,
            side,
            req.price,
            req.size_lots,
            collateral,
            allow_cross_and_isolated,
        )
        .await
        .map_err(|e| {
            AppError::Phoenix(format!("Failed to build isolated limit order: {}", e))
        })?;

    Ok(Json(serialize_instructions(
        instructions,
        format!(
            "Isolated limit {} order: {} lots at ${} on {}",
            req.side, req.size_lots, req.price, req.symbol
        ),
    )))
}

// ---------------------------------------------------------------------------
// Collateral & subaccount handlers (new)
// ---------------------------------------------------------------------------

async fn transfer_collateral(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TransferCollateralRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building transfer collateral: sub {} -> sub {}",
        req.from_subaccount_index,
        req.to_subaccount_index
    );

    let authority = parse_authority(&req.authority)?;

    // Validate subaccount indices (0 = cross-margin, 1-100 = isolated)
    if req.from_subaccount_index > 100 || req.to_subaccount_index > 100 {
        return Err(AppError::BadRequest(
            "subaccount indices must be between 0 and 100".to_string(),
        ));
    }
    if req.from_subaccount_index == req.to_subaccount_index {
        return Err(AppError::BadRequest(
            "from and to subaccount indices must be different".to_string(),
        ));
    }

    let src_pda = TraderKey::derive_pda(&authority, 0, req.from_subaccount_index);
    let dst_pda = TraderKey::derive_pda(&authority, 0, req.to_subaccount_index);

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let instructions = if let Some(amount_usdc) = req.amount_usdc {
        validate_amount(amount_usdc)?;
        builder
            .build_transfer_collateral(authority, src_pda, dst_pda, amount_usdc)
            .map_err(|e| {
                AppError::Phoenix(format!("Failed to build transfer collateral: {}", e))
            })?
    } else {
        // Sweep all collateral — only valid for child→parent (to cross-margin)
        if req.to_subaccount_index != 0 {
            return Err(AppError::BadRequest(
                "amount_usdc is required when destination is not cross-margin (index 0)"
                    .to_string(),
            ));
        }
        builder
            .build_transfer_collateral_child_to_parent(authority, src_pda, dst_pda)
            .map_err(|e| {
                AppError::Phoenix(format!("Failed to build transfer collateral: {}", e))
            })?
    };

    Ok(Json(serialize_instructions(
        instructions,
        format!(
            "Transfer collateral: sub {} -> sub {}",
            req.from_subaccount_index, req.to_subaccount_index
        ),
    )))
}

async fn register_subaccount(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterSubaccountRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building register subaccount: index {}",
        req.subaccount_index
    );

    validate_subaccount_index(req.subaccount_index)?;
    let authority = parse_authority(&req.authority)?;

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    // Register the isolated subaccount
    let mut instructions = builder
        .build_register_trader(authority, 0, req.subaccount_index)
        .map_err(|e| AppError::Phoenix(format!("Failed to build register trader: {}", e)))?;

    // Sync parent capabilities to the new child subaccount
    let parent_pda = TraderKey::derive_pda(&authority, 0, 0);
    let child_pda = TraderKey::derive_pda(&authority, 0, req.subaccount_index);
    let sync_ixs = builder
        .build_sync_parent_to_child(authority, parent_pda, child_pda)
        .map_err(|e| {
            AppError::Phoenix(format!("Failed to build sync parent to child: {}", e))
        })?;
    instructions.extend(sync_ixs);

    Ok(Json(serialize_instructions(
        instructions,
        format!("Register subaccount {}", req.subaccount_index),
    )))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        // Cross-margin
        .route("/market-order", post(market_order))
        .route("/limit-order", post(limit_order))
        .route("/cancel-orders", post(cancel_orders))
        .route("/deposit", post(deposit))
        .route("/withdraw", post(withdraw))
        // Isolated margin
        .route("/isolated-market-order", post(isolated_market_order))
        .route("/isolated-limit-order", post(isolated_limit_order))
        // Collateral & subaccounts
        .route("/transfer-collateral", post(transfer_collateral))
        .route("/register-subaccount", post(register_subaccount))
}
