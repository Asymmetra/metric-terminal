//! Phoenix instruction construction for Rust.
//!
//! This crate provides functions for building Solana instructions
//! to interact with the Phoenix perpetuals exchange.
//!
//! # Example
//!
//! ```no_run
//! use phoenix_ix::{LimitOrderParams, Side, create_place_limit_order_ix};
//! use solana_pubkey::Pubkey;
//!
//! let params = LimitOrderParams::builder()
//!     .trader(Pubkey::new_unique())
//!     .trader_account(Pubkey::new_unique())
//!     .perp_asset_map(Pubkey::new_unique())
//!     .orderbook(Pubkey::new_unique())
//!     .spline_collection(Pubkey::new_unique())
//!     .global_trader_index(vec![Pubkey::new_unique()])
//!     .active_trader_buffer(vec![Pubkey::new_unique()])
//!     .side(Side::Bid)
//!     .price_in_ticks(50000)
//!     .num_base_lots(1000)
//!     .build()
//!     .unwrap();
//!
//! let ix = create_place_limit_order_ix(params);
//! ```

mod cancel_orders;
mod constants;
mod create_ata;
mod deposit_funds;
mod ember_deposit;
mod ember_withdraw;
mod error;
mod limit_order;
mod market_order;
mod order_packet;
mod spl_approve;
mod types;
mod withdraw_funds;

pub use cancel_orders::{CancelOrdersByIdParams, create_cancel_orders_by_id_ix};
pub use constants::*;
pub use create_ata::create_associated_token_account_idempotent_ix;
pub use deposit_funds::{DepositFundsParams, create_deposit_funds_ix};
pub use ember_deposit::{EmberDepositParams, create_ember_deposit_ix};
pub use ember_withdraw::{EmberWithdrawParams, create_ember_withdraw_ix};
pub use error::PhoenixIxError;
pub use limit_order::{LimitOrderParams, LimitOrderParamsBuilder, create_place_limit_order_ix};
pub use market_order::{MarketOrderParams, create_place_market_order_ix};
pub use order_packet::{OrderPacket, client_order_id_to_bytes};
pub use spl_approve::{SplApproveParams, create_spl_approve_ix};
pub use types::*;
pub use withdraw_funds::{WithdrawFundsParams, create_withdraw_funds_ix};
