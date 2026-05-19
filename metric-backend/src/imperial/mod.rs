//! Imperial Trading API client.
//!
//! Source of truth: https://api.imperial.space/api/v1/openapi.json
//!
//! Scope: read-side endpoints + WS subscriptions only. Order placement is
//! JWT-delegated per-wallet, so the frontend calls those endpoints directly.
//! This module is the backend's view of Imperial — markets aggregation,
//! deposit/withdraw build-tx pass-through, and the upstream WS relay.

pub mod candles;
pub mod error;
pub mod http;
pub mod types;
pub mod ws;

pub use error::ImperialError;
