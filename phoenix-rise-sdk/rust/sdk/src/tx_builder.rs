//! Transaction builder for Phoenix perpetuals exchange.
//!
//! This module provides `PhoenixTxBuilder`, which builds Solana instructions
//! from exchange metadata without requiring network access or keypairs.

use std::str::FromStr;

use phoenix_ix::{
    CancelId, CancelOrdersByIdParams, DepositFundsParams, EmberDepositParams, EmberWithdrawParams,
    LimitOrderParams, MarketOrderParams, Side, SplApproveParams, USDC_MINT, WithdrawFundsParams,
    create_associated_token_account_idempotent_ix, create_cancel_orders_by_id_ix,
    create_deposit_funds_ix, create_ember_deposit_ix, create_ember_withdraw_ix,
    create_place_limit_order_ix, create_place_market_order_ix, create_spl_approve_ix,
    create_withdraw_funds_ix, get_associated_token_address, get_ember_state_address,
    get_ember_vault_address,
};
use phoenix_math_utils::{MathError, WrapperNum};
use phoenix_types::ExchangeMarketConfig;
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;
use thiserror::Error;

use crate::PhoenixMetadata;

/// Errors that can occur when building Phoenix transactions.
#[derive(Debug, Error)]
pub enum PhoenixTxBuilderError {
    /// Instruction construction error.
    #[error("Instruction error: {0}")]
    Instruction(#[from] phoenix_ix::PhoenixIxError),

    /// Failed to parse pubkey.
    #[error("Invalid pubkey: {0}")]
    InvalidPubkey(#[from] solana_pubkey::ParsePubkeyError),

    /// Unknown market symbol.
    #[error("Unknown symbol: {0}")]
    UnknownSymbol(String),

    /// Math conversion error (e.g., price to ticks).
    #[error("Math error: {0}")]
    Math(#[from] MathError),
}

/// Parsed addresses from exchange metadata for instruction building.
struct ParsedAddresses {
    perp_asset_map: Pubkey,
    global_trader_index: Vec<Pubkey>,
    active_trader_buffer: Vec<Pubkey>,
    orderbook: Pubkey,
    spline_collection: Pubkey,
}

/// Transaction builder for Phoenix perpetuals exchange.
///
/// Builds Solana instructions from exchange metadata without requiring
/// network access. Use this when you need fine-grained control over
/// transaction construction or want to batch instructions.
///
/// # Example
///
/// ```no_run
/// use phoenix_sdk::{PhoenixHttpClient, PhoenixMetadata, PhoenixTxBuilder, Side};
/// use solana_pubkey::Pubkey;
///
/// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
/// let http = PhoenixHttpClient::new_from_env();
/// let exchange = http.get_exchange().await?.into();
/// let metadata = PhoenixMetadata::new(exchange);
/// let builder = PhoenixTxBuilder::new(&metadata);
///
/// let authority = Pubkey::new_unique();
/// let trader_pda = Pubkey::new_unique();
///
/// // Build instructions without sending
/// let ixs = builder.build_market_order(
///     authority,
///     trader_pda,
///     "SOL",
///     Side::Bid,
///     100,
/// )?;
/// # Ok(())
/// # }
/// ```
pub struct PhoenixTxBuilder<'a> {
    metadata: &'a PhoenixMetadata,
}

impl std::fmt::Debug for PhoenixTxBuilder<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PhoenixTxBuilder")
            .field("metadata", &self.metadata)
            .finish()
    }
}

impl<'a> PhoenixTxBuilder<'a> {
    /// Creates a new transaction builder from exchange metadata.
    pub fn new(metadata: &'a PhoenixMetadata) -> Self {
        Self { metadata }
    }

    /// Build a market order instruction with pre-built params.
    ///
    /// # Arguments
    ///
    /// * `params` - Pre-built market order params
    ///
    /// # Returns
    ///
    /// A vector containing the market order instruction.
    pub fn build_market_order_with_params(
        &self,
        params: MarketOrderParams,
    ) -> Result<Vec<Instruction>, PhoenixTxBuilderError> {
        let ix = create_place_market_order_ix(params)?;
        Ok(vec![ix.into()])
    }

    /// Build a market order instruction.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's wallet address (signer)
    /// * `trader_pda` - The trader's PDA account
    /// * `symbol` - Market symbol ("SOL", "BTC", "ETH")
    /// * `side` - Order side (Bid or Ask)
    /// * `num_base_lots` - Size in base lots
    ///
    /// # Returns
    ///
    /// A vector containing the market order instruction.
    pub fn build_market_order(
        &self,
        authority: Pubkey,
        trader_pda: Pubkey,
        symbol: &str,
        side: Side,
        num_base_lots: u64,
    ) -> Result<Vec<Instruction>, PhoenixTxBuilderError> {
        let market = self
            .metadata
            .get_market(symbol)
            .ok_or_else(|| PhoenixTxBuilderError::UnknownSymbol(symbol.to_string()))?;

        let addrs = self.parse_addresses(market)?;

        let params = MarketOrderParams::builder()
            .trader(authority)
            .trader_account(trader_pda)
            .perp_asset_map(addrs.perp_asset_map)
            .orderbook(addrs.orderbook)
            .spline_collection(addrs.spline_collection)
            .global_trader_index(addrs.global_trader_index)
            .active_trader_buffer(addrs.active_trader_buffer)
            .side(side)
            .num_base_lots(num_base_lots)
            .build()?;

        let ix = create_place_market_order_ix(params)?;
        Ok(vec![ix.into()])
    }

    /// Build a limit order instruction with pre-built params.
    ///
    /// # Arguments
    ///
    /// * `params` - Pre-built limit order params
    ///
    /// # Returns
    ///
    /// A vector containing the limit order instruction.
    pub fn build_limit_order_with_params(
        &self,
        params: LimitOrderParams,
    ) -> Result<Vec<Instruction>, PhoenixTxBuilderError> {
        let ix = create_place_limit_order_ix(params)?;
        Ok(vec![ix.into()])
    }

    /// Build a limit order instruction.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's wallet address (signer)
    /// * `trader_pda` - The trader's PDA account
    /// * `symbol` - Market symbol
    /// * `side` - Order side
    /// * `price` - Limit price in USD (e.g., 150.50 for $150.50)
    /// * `num_base_lots` - Size in base lots
    ///
    /// # Returns
    ///
    /// A vector containing the limit order instruction.
    pub fn build_limit_order(
        &self,
        authority: Pubkey,
        trader_pda: Pubkey,
        symbol: &str,
        side: Side,
        price: f64,
        num_base_lots: u64,
    ) -> Result<Vec<Instruction>, PhoenixTxBuilderError> {
        let market = self
            .metadata
            .get_market(symbol)
            .ok_or_else(|| PhoenixTxBuilderError::UnknownSymbol(symbol.to_string()))?;

        let calc = self
            .metadata
            .get_market_calculator(symbol)
            .ok_or_else(|| PhoenixTxBuilderError::UnknownSymbol(symbol.to_string()))?;

        let price_in_ticks = calc.price_to_ticks(price)?.as_inner();

        let addrs = self.parse_addresses(market)?;

        let params = LimitOrderParams::builder()
            .trader(authority)
            .trader_account(trader_pda)
            .perp_asset_map(addrs.perp_asset_map)
            .orderbook(addrs.orderbook)
            .spline_collection(addrs.spline_collection)
            .global_trader_index(addrs.global_trader_index)
            .active_trader_buffer(addrs.active_trader_buffer)
            .side(side)
            .price_in_ticks(price_in_ticks)
            .num_base_lots(num_base_lots)
            .build()?;

        let ix = create_place_limit_order_ix(params)?;
        Ok(vec![ix.into()])
    }

    /// Build cancel orders instruction.
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's wallet address (signer)
    /// * `trader_pda` - The trader's PDA account
    /// * `symbol` - Market symbol
    /// * `order_ids` - List of order IDs to cancel
    ///
    /// # Returns
    ///
    /// A vector containing the cancel orders instruction.
    pub fn build_cancel_orders(
        &self,
        authority: Pubkey,
        trader_pda: Pubkey,
        symbol: &str,
        order_ids: Vec<CancelId>,
    ) -> Result<Vec<Instruction>, PhoenixTxBuilderError> {
        let market = self
            .metadata
            .get_market(symbol)
            .ok_or_else(|| PhoenixTxBuilderError::UnknownSymbol(symbol.to_string()))?;

        let addrs = self.parse_addresses(market)?;

        let params = CancelOrdersByIdParams::builder()
            .trader(authority)
            .trader_account(trader_pda)
            .perp_asset_map(addrs.perp_asset_map)
            .orderbook(addrs.orderbook)
            .spline_collection(addrs.spline_collection)
            .global_trader_index(addrs.global_trader_index)
            .active_trader_buffer(addrs.active_trader_buffer)
            .order_ids(order_ids)
            .build()?;

        let ix = create_cancel_orders_by_id_ix(params)?;
        Ok(vec![ix.into()])
    }

    /// Build deposit funds instructions.
    ///
    /// This method builds the full deposit flow:
    /// 1. Creates ATA for Phoenix tokens if needed (idempotent)
    /// 2. Deposits USDC via Ember to receive Phoenix tokens
    /// 3. Deposits Phoenix tokens into the Phoenix protocol
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's wallet address (signer)
    /// * `trader_pda` - The trader's PDA account
    /// * `usdc_amount` - Amount of USDC to deposit (e.g., 100.0 for $100)
    ///
    /// # Returns
    ///
    /// A vector containing 3 instructions that should be sent in a single transaction.
    pub fn build_deposit_funds(
        &self,
        authority: Pubkey,
        trader_pda: Pubkey,
        usdc_amount: f64,
    ) -> Result<Vec<Instruction>, PhoenixTxBuilderError> {
        // Convert USDC amount to base units (6 decimals)
        let amount = (usdc_amount * 1_000_000.0) as u64;

        // Get exchange keys from metadata
        let keys = self.metadata.keys();
        let canonical_mint = Pubkey::from_str(&keys.canonical_mint)?;
        let global_vault = Pubkey::from_str(&keys.global_vault)?;
        let global_trader_index = parse_pubkey_vec(&keys.global_trader_index)?;
        let active_trader_buffer = parse_pubkey_vec(&keys.active_trader_buffer)?;

        // Derive addresses
        let trader_usdc_ata = get_associated_token_address(&authority, &USDC_MINT);
        let trader_phoenix_ata = get_associated_token_address(&authority, &canonical_mint);
        let ember_state = get_ember_state_address();
        let ember_vault = get_ember_vault_address();

        // 1. Create ATA instruction (idempotent)
        let create_ata_ix =
            create_associated_token_account_idempotent_ix(authority, authority, canonical_mint);

        // 2. Ember deposit instruction (USDC -> Phoenix tokens)
        let ember_params = EmberDepositParams::builder()
            .trader(authority)
            .ember_state(ember_state)
            .ember_vault(ember_vault)
            .usdc_mint(USDC_MINT)
            .canonical_mint(canonical_mint)
            .trader_usdc_account(trader_usdc_ata)
            .trader_phoenix_account(trader_phoenix_ata)
            .amount(amount)
            .build()?;
        let ember_ix = create_ember_deposit_ix(ember_params)?;

        // 3. Deposit funds instruction (Phoenix tokens -> protocol)
        let deposit_params = DepositFundsParams::builder()
            .trader(authority)
            .trader_account(trader_pda)
            .canonical_mint(canonical_mint)
            .global_vault(global_vault)
            .trader_token_account(trader_phoenix_ata)
            .global_trader_index(global_trader_index)
            .active_trader_buffer(active_trader_buffer)
            .amount(amount)
            .build()?;
        let deposit_ix = create_deposit_funds_ix(deposit_params)?;

        Ok(vec![
            create_ata_ix.into(),
            ember_ix.into(),
            deposit_ix.into(),
        ])
    }

    /// Build withdraw funds instructions.
    ///
    /// This method builds the full withdrawal flow:
    /// 1. Creates ATA for Phoenix tokens if needed (idempotent)
    /// 2. Approves Ember state to spend Phoenix tokens
    /// 3. Creates ATA for USDC if needed (idempotent)
    /// 4. Withdraws Phoenix tokens from Phoenix protocol
    /// 5. Converts Phoenix tokens to USDC via Ember
    ///
    /// # Arguments
    ///
    /// * `authority` - The trader's wallet address (signer)
    /// * `trader_pda` - The trader's PDA account
    /// * `usdc_amount` - Amount of USDC to withdraw (e.g., 100.0 for $100)
    ///
    /// # Returns
    ///
    /// A vector containing 5 instructions that should be sent in a single transaction.
    pub fn build_withdraw_funds(
        &self,
        authority: Pubkey,
        trader_pda: Pubkey,
        usdc_amount: f64,
    ) -> Result<Vec<Instruction>, PhoenixTxBuilderError> {
        // Convert USDC amount to base units (6 decimals)
        let amount = (usdc_amount * 1_000_000.0) as u64;

        // Get exchange keys from metadata
        let keys = self.metadata.keys();
        let canonical_mint = Pubkey::from_str(&keys.canonical_mint)?;
        let global_vault = Pubkey::from_str(&keys.global_vault)?;
        let perp_asset_map = Pubkey::from_str(&keys.perp_asset_map)?;
        let withdraw_queue = Pubkey::from_str(&keys.withdraw_queue)?;
        let global_trader_index = parse_pubkey_vec(&keys.global_trader_index)?;
        let active_trader_buffer = parse_pubkey_vec(&keys.active_trader_buffer)?;

        // Derive addresses
        let trader_usdc_ata = get_associated_token_address(&authority, &USDC_MINT);
        let trader_phoenix_ata = get_associated_token_address(&authority, &canonical_mint);
        let ember_state = get_ember_state_address();
        let ember_vault = get_ember_vault_address();

        // 1. Create Phoenix token ATA instruction (idempotent)
        let create_phoenix_ata_ix =
            create_associated_token_account_idempotent_ix(authority, authority, canonical_mint);

        // 2. SPL Token Approve instruction (delegate Ember state to spend Phoenix tokens)
        let approve_params = SplApproveParams::builder()
            .source(trader_phoenix_ata)
            .delegate(ember_state)
            .owner(authority)
            .amount(amount)
            .build()?;
        let approve_ix = create_spl_approve_ix(approve_params)?;

        // 3. Create USDC ATA instruction (idempotent)
        let create_usdc_ata_ix =
            create_associated_token_account_idempotent_ix(authority, authority, USDC_MINT);

        // 4. Withdraw funds instruction (Phoenix protocol -> Phoenix token ATA)
        let withdraw_params = WithdrawFundsParams::builder()
            .trader(authority)
            .trader_account(trader_pda)
            .perp_asset_map(perp_asset_map)
            .global_vault(global_vault)
            .trader_token_account(trader_phoenix_ata)
            .global_trader_index(global_trader_index)
            .active_trader_buffer(active_trader_buffer)
            .withdraw_queue(withdraw_queue)
            .amount(amount)
            .build()?;
        let withdraw_ix = create_withdraw_funds_ix(withdraw_params)?;

        // 5. Ember withdraw instruction (Phoenix tokens -> USDC)
        let ember_params = EmberWithdrawParams::builder()
            .trader(authority)
            .ember_state(ember_state)
            .ember_vault(ember_vault)
            .usdc_mint(USDC_MINT)
            .canonical_mint(canonical_mint)
            .trader_usdc_account(trader_usdc_ata)
            .trader_phoenix_account(trader_phoenix_ata)
            .amount(Some(amount))
            .build()?;
        let ember_ix = create_ember_withdraw_ix(ember_params)?;

        Ok(vec![
            create_phoenix_ata_ix.into(),
            approve_ix.into(),
            create_usdc_ata_ix.into(),
            withdraw_ix.into(),
            ember_ix.into(),
        ])
    }

    /// Parse all required addresses from the exchange metadata for a given market.
    fn parse_addresses(
        &self,
        market: &ExchangeMarketConfig,
    ) -> Result<ParsedAddresses, PhoenixTxBuilderError> {
        let keys = self.metadata.keys();
        let perp_asset_map = Pubkey::from_str(&keys.perp_asset_map)?;
        let global_trader_index = parse_pubkey_vec(&keys.global_trader_index)?;
        let active_trader_buffer = parse_pubkey_vec(&keys.active_trader_buffer)?;
        let orderbook = Pubkey::from_str(&market.market_pubkey)?;
        let spline_collection = Pubkey::from_str(&market.spline_pubkey)?;

        Ok(ParsedAddresses {
            perp_asset_map,
            global_trader_index,
            active_trader_buffer,
            orderbook,
            spline_collection,
        })
    }
}

/// Parse a vector of base58-encoded pubkeys.
fn parse_pubkey_vec(strings: &[String]) -> Result<Vec<Pubkey>, PhoenixTxBuilderError> {
    strings
        .iter()
        .map(|s| Pubkey::from_str(s).map_err(PhoenixTxBuilderError::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pubkey_vec() {
        // Valid Solana pubkeys (32 bytes, base58 encoded)
        let pubkeys = vec![
            "11111111111111111111111111111112".to_string(), // System program
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string(), // SPL Token
        ];
        let result = parse_pubkey_vec(&pubkeys).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_parse_pubkey_vec_invalid() {
        let pubkeys = vec!["invalid".to_string()];
        let result = parse_pubkey_vec(&pubkeys);
        assert!(result.is_err());
    }
}
