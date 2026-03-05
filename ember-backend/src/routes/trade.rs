use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use phoenix_ix::{create_place_stop_loss_ix, Direction, StopLossOrderKind, StopLossParams};
use phoenix_math_utils::WrapperNum;
use phoenix_sdk::{BracketLegOrders, CancelId, IsolatedCollateralFlow, PhoenixMetadata, PhoenixTxBuilder, PlaceIsolatedLimitOrderRequest, PlaceIsolatedMarketOrderRequest, Side, TraderKey};
use serde::{Deserialize, Deserializer, de};
use solana_instruction::Instruction;
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
    #[serde(default)]
    pub stop_loss_price: Option<f64>,
    #[serde(default)]
    pub take_profit_price: Option<f64>,
}

/// Deserialize a u64 that may arrive as a JSON number or a JSON string.
/// This is needed because JavaScript cannot represent u64 values precisely
/// (Number.MAX_SAFE_INTEGER = 2^53 - 1), so Phoenix SDK and frontends
/// may serialize these fields as strings.
fn deserialize_u64_or_string<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrU64 {
        Num(u64),
        Str(String),
    }
    match StringOrU64::deserialize(deserializer)? {
        StringOrU64::Num(n) => Ok(n),
        StringOrU64::Str(s) => s.parse().map_err(de::Error::custom),
    }
}

#[derive(Deserialize)]
pub struct CancelOrderId {
    /// USD price of the order (e.g. 50.0 for $50). Converted to on-chain
    /// ticks via the market calculator's price_to_ticks().
    pub price: f64,
    #[serde(deserialize_with = "deserialize_u64_or_string")]
    pub order_sequence_number: u64,
}

#[derive(Deserialize)]
pub struct CancelOrdersRequest {
    pub authority: String,
    pub symbol: String,
    pub order_ids: Vec<CancelOrderId>,
    #[serde(default)]
    pub subaccount_index: Option<u8>,
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
    /// Isolated subaccount index (1–100). When provided, targets that specific
    /// isolated subaccount slot. Defaults to None (Phoenix API picks the slot).
    #[serde(default)]
    pub subaccount_index: Option<u8>,
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
    /// Isolated subaccount index (1–100). Required when stop_loss_price or
    /// take_profit_price is set — used to bind bracket orders to the correct
    /// subaccount PDA.
    #[serde(default)]
    pub subaccount_index: Option<u8>,
    #[serde(default)]
    pub stop_loss_price: Option<f64>,
    #[serde(default)]
    pub take_profit_price: Option<f64>,
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
    /// Subaccount index: 0 = cross-margin, 1–100 = isolated.
    pub subaccount_index: u8,
}

/// Position to close in a batch close-all operation.
#[derive(Deserialize)]
pub struct ClosePositionItem {
    pub symbol: String,
    /// "long" or "short" - the side of the position to close
    pub side: String,
    /// Size in base lots
    pub size_lots: u64,
    /// "cross" or "isolated"
    pub margin_mode: String,
    /// Subaccount index (0 for cross, 1-100 for isolated)
    pub subaccount_index: u8,
}

#[derive(Deserialize)]
pub struct CloseAllPositionsRequest {
    pub authority: String,
    pub positions: Vec<ClosePositionItem>,
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
    if index > 100 {
        return Err(AppError::BadRequest(
            "subaccount_index must be between 0 and 100".to_string(),
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

/// Build bracket leg (TP/SL) stop-loss instructions for a limit order.
/// Replicates the private `build_bracket_leg_orders` logic from the SDK.
fn build_bracket_leg_ixs(
    metadata: &PhoenixMetadata,
    symbol: &str,
    authority: Pubkey,
    trader_account: Pubkey,
    primary_side: Side,
    bracket: &BracketLegOrders,
) -> Result<Vec<Instruction>, AppError> {
    let market = metadata
        .get_market(symbol)
        .ok_or_else(|| AppError::MarketNotFound(symbol.to_string()))?;
    let calc = metadata
        .get_market_calculator(symbol)
        .ok_or_else(|| AppError::MarketNotFound(symbol.to_string()))?;

    let keys = metadata.keys();
    let perp_asset_map = Pubkey::from_str(&keys.perp_asset_map)
        .map_err(|e| AppError::Phoenix(format!("Invalid perp_asset_map pubkey: {}", e)))?;
    let global_trader_index: Vec<Pubkey> = keys
        .global_trader_index
        .iter()
        .map(|s| Pubkey::from_str(s).map_err(|e| AppError::Phoenix(format!("Invalid pubkey: {}", e))))
        .collect::<Result<_, _>>()?;
    let active_trader_buffer: Vec<Pubkey> = keys
        .active_trader_buffer
        .iter()
        .map(|s| Pubkey::from_str(s).map_err(|e| AppError::Phoenix(format!("Invalid pubkey: {}", e))))
        .collect::<Result<_, _>>()?;
    let orderbook = Pubkey::from_str(&market.market_pubkey)
        .map_err(|e| AppError::Phoenix(format!("Invalid orderbook pubkey: {}", e)))?;
    let spline_collection = Pubkey::from_str(&market.spline_pubkey)
        .map_err(|e| AppError::Phoenix(format!("Invalid spline pubkey: {}", e)))?;
    let asset_id = market.asset_id as u64;

    let (bracket_trade_side, sl_direction, tp_direction) = match primary_side {
        Side::Bid => (Side::Ask, Direction::LessThan, Direction::GreaterThan),
        Side::Ask => (Side::Bid, Direction::GreaterThan, Direction::LessThan),
    };

    let mut ixs = Vec::new();

    if let Some(sl_price) = bracket.stop_loss_price {
        let price_in_ticks = calc
            .price_to_ticks(sl_price)
            .map_err(|e| AppError::Phoenix(format!("SL price conversion failed: {}", e)))?
            .as_inner();
        let params = StopLossParams::builder()
            .funder(authority)
            .trader_account(trader_account)
            .position_authority(authority)
            .perp_asset_map(perp_asset_map)
            .orderbook(orderbook)
            .spline_collection(spline_collection)
            .global_trader_index(global_trader_index.clone())
            .active_trader_buffer(active_trader_buffer.clone())
            .asset_id(asset_id)
            .trigger_price(price_in_ticks)
            .execution_price(price_in_ticks)
            .trade_side(bracket_trade_side)
            .execution_direction(sl_direction)
            .order_kind(StopLossOrderKind::IOC)
            .build()
            .map_err(|e| AppError::Phoenix(format!("Failed to build SL params: {}", e)))?;
        ixs.push(
            create_place_stop_loss_ix(params)
                .map_err(|e| AppError::Phoenix(format!("Failed to build SL ix: {}", e)))?
                .into(),
        );
    }

    if let Some(tp_price) = bracket.take_profit_price {
        let price_in_ticks = calc
            .price_to_ticks(tp_price)
            .map_err(|e| AppError::Phoenix(format!("TP price conversion failed: {}", e)))?
            .as_inner();
        let params = StopLossParams::builder()
            .funder(authority)
            .trader_account(trader_account)
            .position_authority(authority)
            .perp_asset_map(perp_asset_map)
            .orderbook(orderbook)
            .spline_collection(spline_collection)
            .global_trader_index(global_trader_index.clone())
            .active_trader_buffer(active_trader_buffer.clone())
            .asset_id(asset_id)
            .trigger_price(price_in_ticks)
            .execution_price(price_in_ticks)
            .trade_side(bracket_trade_side)
            .execution_direction(tp_direction)
            .order_kind(StopLossOrderKind::IOC)
            .build()
            .map_err(|e| AppError::Phoenix(format!("Failed to build TP params: {}", e)))?;
        ixs.push(
            create_place_stop_loss_ix(params)
                .map_err(|e| AppError::Phoenix(format!("Failed to build TP ix: {}", e)))?
                .into(),
        );
    }

    Ok(ixs)
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

    // TP/SL bracket orders are architecturally unsupported on limit orders:
    // place_stop_loss requires an existing open position, but a resting limit
    // order hasn't filled at TX time — Phoenix returns error 7002.
    if req.take_profit_price.is_some() || req.stop_loss_price.is_some() {
        return Err(AppError::BadRequest(
            "Bracket orders (TP/SL) are not supported for limit orders. \
             Use a market order for bracket functionality."
                .to_string(),
        ));
    }

    validate_size_lots(req.size_lots)?;
    validate_price(req.price)?;
    let authority = parse_authority(&req.authority)?;
    let side = parse_side(&req.side)?;
    let trader_pda = TraderKey::derive_pda(&authority, 0, 0);
    let bracket = build_bracket(req.stop_loss_price, req.take_profit_price)?;

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);

    let mut instructions = builder
        .build_limit_order(
            authority,
            trader_pda,
            &req.symbol,
            side,
            req.price,
            req.size_lots,
        )
        .map_err(|e| AppError::Phoenix(format!("Failed to build limit order: {}", e)))?;

    // Append bracket leg (TP/SL) instructions if requested.
    // These place on-chain stop-loss orders that trigger after the limit order fills.
    if let Some(ref bracket_legs) = bracket {
        let bracket_ixs = build_bracket_leg_ixs(&metadata, &req.symbol, authority, trader_pda, side, bracket_legs)?;
        instructions.extend(bracket_ixs);
    }

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
    let subaccount_index = req.subaccount_index.unwrap_or(0);
    validate_subaccount_index(subaccount_index)?;
    let trader_pda = TraderKey::derive_pda(&authority, 0, subaccount_index);

    let metadata = state.metadata.read().await;

    let calc = metadata
        .get_market_calculator(&req.symbol)
        .ok_or_else(|| AppError::MarketNotFound(req.symbol.clone()))?;

    let order_ids: Vec<CancelId> = req
        .order_ids
        .iter()
        .map(|id| {
            let price_in_ticks = calc
                .price_to_ticks(id.price)
                .map_err(|e| AppError::BadRequest(format!("Invalid price {}: {}", id.price, e)))?
                .as_inner();
            Ok(CancelId::new(price_in_ticks, id.order_sequence_number))
        })
        .collect::<Result<Vec<_>, AppError>>()?;

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

    // Check if trader is registered on Phoenix — if not, prepend registration
    let mut all_instructions: Vec<Instruction> = Vec::new();

    let trader_registered = state
        .http_client
        .get_traders(&authority)
        .await
        .map(|traders| {
            traders
                .iter()
                .any(|t| t.trader_subaccount_index == 0)
        })
        .unwrap_or(false);

    if !trader_registered {
        tracing::info!(
            "Trader {} not registered on Phoenix, prepending registration",
            req.authority
        );
        let register_ixs = builder
            .build_register_trader(authority, 0, 0)
            .map_err(|e| {
                AppError::Phoenix(format!("Failed to build register trader: {}", e))
            })?;
        all_instructions.extend(register_ixs);
    }

    let deposit_ixs = builder
        .build_deposit_funds(authority, trader_pda, req.amount_usdc)
        .map_err(|e| AppError::Phoenix(format!("Failed to build deposit: {}", e)))?;
    all_instructions.extend(deposit_ixs);

    Ok(Json(serialize_instructions(
        all_instructions,
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
    parse_authority(&req.authority)?; // validate pubkey format
    let side = parse_side(&req.side)?;
    let collateral = build_collateral(req.collateral_usdc)?;
    let bracket = build_bracket(req.stop_loss_price, req.take_profit_price)?;
    let allow_cross_and_isolated = req.allow_cross_and_isolated.unwrap_or(false);

    let transfer_amount = match &collateral {
        Some(IsolatedCollateralFlow::TransferFromCrossMargin { collateral }) => *collateral,
        _ => 0,
    };
    let tp_sl = bracket.as_ref().map(BracketLegOrders::to_tp_sl_config);

    let instructions = state
        .http_client
        .build_isolated_market_order_tx_with_request(PlaceIsolatedMarketOrderRequest {
            authority: req.authority.clone(),
            symbol: req.symbol.clone(),
            side: side.to_api_string().to_string(),
            num_base_lots: Some(req.size_lots),
            transfer_amount,
            pda_index: req.subaccount_index,
            allow_cross_and_isolated_for_asset: Some(allow_cross_and_isolated),
            tp_sl,
            ..Default::default()
        })
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
    let _collateral = build_collateral(req.collateral_usdc)?; // validate; transfer built locally below
    let bracket = build_bracket(req.stop_loss_price, req.take_profit_price)?;
    let allow_cross_and_isolated = req.allow_cross_and_isolated.unwrap_or(false);

    // Validate subaccount_index is provided when bracket orders are requested.
    // Bracket ixs must reference the exact isolated subaccount PDA — without
    // knowing the subaccount index we'd bind them to the wrong account.
    let bracket_subaccount_index: Option<u8> = if bracket.is_some() {
        let idx = req.subaccount_index.ok_or_else(|| {
            AppError::BadRequest(
                "subaccount_index (1–100) is required when stop_loss_price or \
                 take_profit_price is set for isolated limit orders"
                    .to_string(),
            )
        })?;
        if idx == 0 || idx > 100 {
            return Err(AppError::BadRequest(
                "subaccount_index must be between 1 and 100 for isolated orders".to_string(),
            ));
        }
        Some(idx)
    } else {
        None
    };

    let metadata = state.metadata.read().await;
    let builder = PhoenixTxBuilder::new(&metadata);
    let mut all_instructions: Vec<Instruction> = Vec::new();

    // Auto-register isolated subaccount if it has not been registered yet.
    // The Phoenix /ix/place-isolated-limit-order endpoint returns 502
    // ("Source account not found") if the isolated subaccount PDA does not
    // exist on-chain. Mirror the deposit handler's auto-registration pattern.
    if let Some(sub_idx) = req.subaccount_index {
        if sub_idx > 0 {
            let is_registered = state
                .http_client
                .get_traders(&authority)
                .await
                .map(|traders| traders.iter().any(|t| t.trader_subaccount_index == sub_idx))
                .unwrap_or(false);

            if !is_registered {
                tracing::info!(
                    "Isolated sub={} not registered for {}, prepending registration",
                    sub_idx,
                    req.authority
                );
                let register_ixs = builder
                    .build_register_trader(authority, 0, sub_idx)
                    .map_err(|e| {
                        AppError::Phoenix(format!("Failed to build register trader: {}", e))
                    })?;
                all_instructions.extend(register_ixs);

                let parent_pda = TraderKey::derive_pda(&authority, 0, 0);
                let child_pda = TraderKey::derive_pda(&authority, 0, sub_idx);
                let sync_ixs = builder
                    .build_sync_parent_to_child(authority, parent_pda, child_pda)
                    .map_err(|e| {
                        AppError::Phoenix(format!("Failed to build sync parent to child: {}", e))
                    })?;
                all_instructions.extend(sync_ixs);
            }
        }
    }

    // Explicitly transfer collateral from cross-margin to the isolated
    // subaccount. Unlike /ix/place-isolated-market-order, the limit order
    // endpoint does NOT process transfer_amount into a collateral transfer
    // instruction — the field is silently ignored. We build the transfer
    // locally and pass transfer_amount=0 to avoid any double-transfer.
    if let (Some(usdc), Some(sub_idx)) = (req.collateral_usdc, req.subaccount_index) {
        if sub_idx > 0 {
            let parent_pda = TraderKey::derive_pda(&authority, 0, 0);
            let child_pda = TraderKey::derive_pda(&authority, 0, sub_idx);
            let transfer_ixs = builder
                .build_transfer_collateral(authority, parent_pda, child_pda, usdc)
                .map_err(|e| {
                    AppError::Phoenix(format!("Failed to build collateral transfer: {}", e))
                })?;
            all_instructions.extend(transfer_ixs);
        }
    }

    // Build the isolated limit order instructions via Phoenix HTTP API.
    // transfer_amount=0 because we have already emitted the transfer above.
    let limit_ixs = state
        .http_client
        .build_isolated_limit_order_tx_with_request(PlaceIsolatedLimitOrderRequest {
            authority: req.authority.clone(),
            symbol: req.symbol.clone(),
            side: side.to_api_string().to_string(),
            price: Some(req.price),
            quantity: Some(req.size_lots as f64),
            transfer_amount: 0,
            pda_index: req.subaccount_index,
            allow_cross_and_isolated_for_asset: Some(allow_cross_and_isolated),
            ..Default::default()
        })
        .await
        .map_err(|e| {
            AppError::Phoenix(format!("Failed to build isolated limit order: {}", e))
        })?;
    all_instructions.extend(limit_ixs);

    // Append bracket leg (TP/SL) instructions bound to the correct subaccount PDA.
    if let (Some(ref bracket_legs), Some(sub_idx)) = (&bracket, bracket_subaccount_index) {
        let trader_pda = TraderKey::derive_pda(&authority, 0, sub_idx);
        let bracket_ixs = build_bracket_leg_ixs(
            &metadata,
            &req.symbol,
            authority,
            trader_pda,
            side,
            bracket_legs,
        )?;
        all_instructions.extend(bracket_ixs);
    }

    Ok(Json(serialize_instructions(
        all_instructions,
        format!(
            "Isolated limit {} order: {} lots at ${} on {}",
            req.side, req.size_lots, req.price, req.symbol
        ),
    )))
}

// ---------------------------------------------------------------------------
// Batch close-all positions handler
// ---------------------------------------------------------------------------

async fn close_all_positions(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CloseAllPositionsRequest>,
) -> Result<Json<TxResponse>, AppError> {
    tracing::info!(
        "Building close-all for {} positions",
        req.positions.len()
    );

    if req.positions.is_empty() {
        return Err(AppError::BadRequest(
            "positions cannot be empty".to_string(),
        ));
    }

    // Enforce position count limit before building instructions.
    // Each market order needs ~4 instructions; Solana TX has a hard size limit.
    const MAX_POSITIONS: usize = 8;
    if req.positions.len() > MAX_POSITIONS {
        return Err(AppError::BadRequest(format!(
            "Too many positions to close in one TX ({} requested, max {}). Close individually.",
            req.positions.len(),
            MAX_POSITIONS
        )));
    }

    let authority = parse_authority(&req.authority)?;

    // Separate positions by margin mode
    let mut cross_positions: Vec<&ClosePositionItem> = Vec::new();
    let mut isolated_positions: Vec<&ClosePositionItem> = Vec::new();

    for pos in &req.positions {
        if pos.margin_mode.to_lowercase() == "isolated" {
            isolated_positions.push(pos);
        } else {
            cross_positions.push(pos);
        }
    }

    let mut all_instructions: Vec<Instruction> = Vec::new();

    // Process cross-margin positions synchronously
    if !cross_positions.is_empty() {
        let metadata = state.metadata.read().await;
        let builder = PhoenixTxBuilder::new(&metadata);

        for pos in cross_positions {
            validate_size_lots(pos.size_lots)?;

            // Parse side and determine close side (opposite of position)
            let position_side = match pos.side.to_lowercase().as_str() {
                "long" => Side::Bid,
                "short" => Side::Ask,
                _ => return Err(AppError::BadRequest(
                    format!("Invalid position side: {}. Use 'long' or 'short'", pos.side)
                )),
            };

            // Close on opposite side
            let close_side = match position_side {
                Side::Bid => Side::Ask,
                Side::Ask => Side::Bid,
            };

            let trader_pda = TraderKey::derive_pda(&authority, 0, pos.subaccount_index);

            let instructions = builder
                .build_market_order(
                    authority,
                    trader_pda,
                    &pos.symbol,
                    close_side,
                    pos.size_lots,
                    None, // No bracket orders for closes
                )
                .map_err(|e| {
                    AppError::Phoenix(format!(
                        "Failed to build cross-margin close for {}: {}",
                        pos.symbol, e
                    ))
                })?;

            all_instructions.extend(instructions);
        }
    }

    // Process isolated positions asynchronously
    // Note: Each isolated order requires an async HTTP call to build
    // This is a limitation of the current SDK design
    for pos in isolated_positions {
        validate_size_lots(pos.size_lots)?;

        let position_side = match pos.side.to_lowercase().as_str() {
            "long" => Side::Bid,
            "short" => Side::Ask,
            _ => return Err(AppError::BadRequest(
                format!("Invalid position side: {}. Use 'long' or 'short'", pos.side)
            )),
        };

        let close_side = match position_side {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        };

        let instructions = state
            .http_client
            .build_isolated_market_order_tx_with_request(PlaceIsolatedMarketOrderRequest {
                authority: req.authority.clone(),
                symbol: pos.symbol.clone(),
                side: close_side.to_api_string().to_string(),
                num_base_lots: Some(pos.size_lots),
                pda_index: Some(pos.subaccount_index),
                is_reduce_only: Some(true),
                ..Default::default()
            })
            .await
            .map_err(|e| {
                AppError::Phoenix(format!(
                    "Failed to build isolated close for {}: {}",
                    pos.symbol, e
                ))
            })?;

        all_instructions.extend(instructions);
    }

    // Check instruction count limits
    // Solana has a ~1232 byte transaction size limit
    // Each market order instruction takes ~3-4 accounts (~100-150 bytes)
    // Conservative limit: 6 market orders per transaction
    const MAX_INSTRUCTIONS: usize = 24; // ~6 market orders (4 ix each)
    if all_instructions.len() > MAX_INSTRUCTIONS {
        return Err(AppError::BadRequest(format!(
            "Too many instructions ({}). Max {} per transaction. Close positions individually.",
            all_instructions.len(),
            MAX_INSTRUCTIONS
        )));
    }

    Ok(Json(serialize_instructions(
        all_instructions,
        format!("Close {} positions", req.positions.len()),
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

    // Register the subaccount (index 0 = cross-margin, 1-100 = isolated)
    let mut instructions = builder
        .build_register_trader(authority, 0, req.subaccount_index)
        .map_err(|e| AppError::Phoenix(format!("Failed to build register trader: {}", e)))?;

    // For isolated subaccounts, sync parent capabilities to the new child
    if req.subaccount_index > 0 {
        let parent_pda = TraderKey::derive_pda(&authority, 0, 0);
        let child_pda = TraderKey::derive_pda(&authority, 0, req.subaccount_index);
        let sync_ixs = builder
            .build_sync_parent_to_child(authority, parent_pda, child_pda)
            .map_err(|e| {
                AppError::Phoenix(format!("Failed to build sync parent to child: {}", e))
            })?;
        instructions.extend(sync_ixs);
    }

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
        // Batch operations
        .route("/close-all-positions", post(close_all_positions))
}
