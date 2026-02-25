# phoenix-sdk

SDK for the Phoenix perpetuals exchange on Solana. Available in Rust and Python.

## Directory Structure

```
rust/
├── Cargo.toml              # Workspace manifest
├── cli/                    # phoenix-sdk-cli crate (smoke-test CLI)
│   ├── Cargo.toml
│   ├── src/
│   │   └── main.rs         # Clap-based CLI for HTTP + WebSocket smoke testing
│   └── scripts/
│       └── smoke_http_client.sh
├── ix/                     # phoenix-ix crate (instruction builders)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs          # Crate root, re-exports instruction builders
│       ├── constants.rs    # Program IDs, discriminants, PDA derivation
│       ├── types.rs        # AccountMeta, Instruction, Side, OrderFlags, etc.
│       ├── error.rs        # PhoenixIxError enum
│       ├── limit_order.rs  # Limit order instruction builder
│       ├── market_order.rs # Market order instruction builder
│       ├── cancel_orders.rs # Cancel orders instruction builder
│       ├── deposit_funds.rs # Deposit funds instruction builder
│       ├── withdraw_funds.rs # Withdraw funds instruction builder
│       ├── ember_deposit.rs # Ember USDC->Phoenix token deposit
│       ├── ember_withdraw.rs # Ember Phoenix token->USDC withdraw
│       ├── spl_approve.rs  # SPL Token approve instruction builder
│       └── create_ata.rs   # Idempotent ATA creation instruction
├── math/                   # phoenix-math-utils crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs          # Crate root, re-exports math utilities
│       ├── direction.rs    # Direction and stop-loss order types
│       ├── errors.rs       # Application-level error types
│       ├── fixed.rs        # I80F48 fixed-point arithmetic wrapper
│       ├── funding.rs      # Funding rate calculations
│       ├── leverage_tiers.rs # Position-size-dependent margin requirements
│       ├── limit_order_state.rs # Limit order margin state aggregation
│       ├── margin.rs       # Per-market margin computation
│       ├── margin_calc.rs  # Core margin calculation formulas
│       ├── market_math.rs  # MarketCalculator for price/lot conversions
│       ├── perp_metadata.rs # Simplified perpetual asset metadata
│       ├── portfolio.rs    # Portfolio-level aggregation across markets
│       ├── price.rs        # Price quantization and tick conversions
│       ├── risk.rs         # Risk assessment types and margin state
│       ├── trader_position.rs # Trader position in a perp market
│       └── quantities/     # Type-safe quantity system (BaseLots, QuoteLots, Ticks, etc.)
├── sdk/                    # phoenix-sdk crate
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs          # Crate root, re-exports main types
│   │   ├── client.rs       # PhoenixClient unified client with reconnection and callbacks
│   │   ├── env.rs          # Environment configuration with defaults
│   │   ├── http_client.rs  # HTTP client for REST API (markets, traders, candles)
│   │   ├── tx_builder.rs   # Transaction builder for orders and deposits
│   │   └── ws_client.rs    # WebSocket client with auto-reconnect
│   ├── examples/
│   │   ├── phoenix_client.rs
│   │   ├── subscribe_trader_state.rs
│   │   ├── subscribe_market_stats.rs
│   │   ├── subscribe_l2_book.rs
│   │   ├── subscribe_candles.rs
│   │   ├── subscribe_trades.rs
│   │   ├── send_market_order.rs
│   │   ├── send_limit_order.rs
│   │   ├── cancel_order.rs
│   │   ├── deposit_funds.rs
│   │   ├── compute_trader_margin.rs
│   │   ├── http_client.rs
│   │   ├── market_maker.rs
│   │   └── ws_debug_cli.rs
│   └── tests/
│       └── trader_state_tests.rs
└── types/                  # phoenix-types crate
    ├── Cargo.toml
    └── src/
        ├── lib.rs          # Crate root, re-exports all types
        ├── candles.rs      # Candle types (Timeframe, ApiCandle, CandleData)
        ├── client.rs       # Client-side types for higher-level SDK clients
        ├── conversions.rs  # Conversion utilities for building margin calc types
        ├── core.rs         # Core primitives (Decimal, Price, Side, PaginatedResponse)
        ├── exchange.rs     # Exchange keys and configuration
        ├── http_error.rs   # HTTP error types
        ├── js_safe_ints.rs # Big integers serialized as strings for JS compatibility
        ├── l2book.rs       # L2 orderbook state container
        ├── market.rs       # Market config, status, orderbook, statistics
        ├── market_state.rs # Combined market state (statistics + orderbook)
        ├── market_stats.rs # Market statistics state container
        ├── metadata.rs     # Exchange metadata caching
        ├── subscription_key.rs # Subscription key for message routing
        ├── trader.rs       # WebSocket protocol types (snapshots, deltas, capabilities)
        ├── trader_http.rs  # HTTP API types (TraderView, order/collateral/funding history)
        ├── trader_key.rs   # TraderKey identification and PDA derivation
        ├── trader_state.rs # Trader state container with snapshot/delta handling
        ├── trades.rs       # Trade event records
        ├── ws.rs           # WebSocket protocol types (subscriptions, client/server messages)
        └── ws_error.rs     # WebSocket error types
```

## Build Commands

All commands run from `rust/` directory:

```bash
cargo build              # Build both crates
cargo test               # Run all tests

# Examples optionally use environment variables:
# PHOENIX_API_URL=https://perp-api.phoenix.trade (optional; for HTTP/RPC and WS derivation)
# PHOENIX_WS_URL=wss://perp-api.phoenix.trade/ws (optional; overrides derived URL)
# PHOENIX_API_KEY=your_api_key (optional; sent as x-api-key when set)

cargo run -p phoenix-sdk --example subscribe_trader_state
cargo run -p phoenix-sdk --example subscribe_l2_book -- SOL
cargo run -p phoenix-sdk --example subscribe_candles -- SOL-PERP 1m
```

## Crates

### phoenix-ix

Solana instruction builders for Phoenix perpetuals exchange:
- **constants** - Program IDs (Phoenix, Ember, SPL Token), instruction discriminants, PDA derivation functions
- **limit_order** - `LimitOrderParams` builder and `create_place_limit_order_ix` function
- **market_order** - `MarketOrderParams` builder and `create_place_market_order_ix` function
- **cancel_orders** - `CancelOrdersByIdParams` builder and `create_cancel_orders_by_id_ix` function
- **deposit_funds** - `DepositFundsParams` builder and `create_deposit_funds_ix` function for depositing Phoenix tokens into the protocol
- **withdraw_funds** - `WithdrawFundsParams` builder and `create_withdraw_funds_ix` function for withdrawing Phoenix tokens from the protocol
- **ember_deposit** - `EmberDepositParams` builder and `create_ember_deposit_ix` function for converting USDC to Phoenix tokens
- **ember_withdraw** - `EmberWithdrawParams` builder and `create_ember_withdraw_ix` function for converting Phoenix tokens to USDC
- **spl_approve** - `SplApproveParams` builder and `create_spl_approve_ix` function for SPL Token approve delegation
- **create_ata** - `create_associated_token_account_idempotent_ix` for creating ATAs

### phoenix-math-utils

Type-safe math utilities for the Phoenix perpetuals exchange:
- **fixed** - `I80F48` fixed-point arithmetic wrapper around the `fixed` crate
- **funding** - Funding rate calculations and conversions
- **market_math** - `MarketCalculator` for converting between prices, ticks, base lots, and quote lots
- **price** - Price quantization and tick conversion utilities
- **quantities** - Type-safe newtype wrappers (`BaseLots`, `QuoteLots`, `Ticks`, etc.) preventing arithmetic errors at compile time
- **direction** - Direction and stop-loss order types for price comparisons
- **errors** - Application-level error types
- **leverage_tiers** - Leverage tiers for position-size-dependent margin requirements
- **limit_order_state** - Limit order margin state aggregation for margin calculations
- **margin** - Core margin types and per-market margin computation
- **margin_calc** - Core margin calculation formulas for perpetual futures positions
- **perp_metadata** - Simplified perpetual asset metadata for margin calculations
- **portfolio** - Portfolio-level types and aggregation across multiple markets
- **risk** - Risk assessment types and margin state
- **trader_position** - `TraderPosition` representing a trader's position in a perp market

### phoenix-types

Minimal serde types matching the Phoenix API wire formats. No runtime dependencies beyond serde.
- **core** - Fundamental primitives (`Decimal`, `Price`, `Side`, `PaginatedResponse`)
- **trader** - WebSocket protocol types for real-time state synchronization (snapshots, deltas, capabilities)
- **trader_http** - HTTP API types for views and history (`TraderView`, `OrderHistoryItem`, `CollateralEvent`, `FundingHistoryEvent`)
- **market** - Market configuration, status enums, orderbook, and statistics
- **exchange** - Exchange keys and authority configuration
- **candles** - Candlestick (OHLCV) data types
- **trades** - Trade event records for WebSocket and HTTP
- **ws** - WebSocket protocol (subscriptions, client/server message envelopes)
- **client** - Client-side types for higher-level SDK clients (`PhoenixSubscription`, `PhoenixClientEvent`, `MarginTrigger`)
- **conversions** - Conversion utilities for building margin calculation types from HTTP/WebSocket data
- **http_error** - HTTP error types for the Phoenix SDK
- **js_safe_ints** - Safe big integers that serialize as strings for JSON/JavaScript compatibility
- **l2book** - L2 orderbook state container for Phoenix markets
- **market_state** - Combined market state container (statistics + orderbook)
- **market_stats** - Market statistics state container
- **metadata** - Exchange metadata caching for the SDK
- **subscription_key** - Subscription key for routing messages to the correct subscriber
- **trader_key** - `TraderKey` identification and PDA derivation
- **trader_state** - Trader state container with snapshot and delta handling
- **ws_error** - WebSocket error types (`PhoenixWsError`)

### phoenix-sdk

- **client** - `PhoenixClient` unified client wrapping WS and HTTP clients with automatic reconnection, lock-free single-owner runtime state, receiver-based `subscribe(...)` API (`PhoenixSubscription`), dependency-aware unsubscribe, and composite subscriptions (including market bundles and trader margin updates)
- **env** - `PhoenixEnv` environment configuration loading with defaults for API URL, WebSocket URL, and API key
- **http_client** - `PhoenixHttpClient` for REST API calls (exchange config, markets, traders, candles, collateral history, funding history)
- **tx_builder** - `PhoenixTxBuilder` builds Solana instructions from `PhoenixMetadata`; provides `build_market_order`, `build_limit_order`, `build_cancel_orders`, `build_deposit_funds`, `build_withdraw_funds` methods
- **ws_client** - `PhoenixWSClient` handles WebSocket connection, auto-reconnect with exponential backoff, and message routing to subscribers; `SubscriptionHandle` returned from subscribe methods enables unsubscription by dropping

### phoenix-sdk-cli

Clap-based smoke-test CLI for exercising the HTTP and WebSocket clients. Supports all HTTP endpoints and WebSocket subscriptions via subcommands.

## Python SDK

```
python/
├── pyproject.toml              # Package config (httpx, pydantic)
├── phoenix_sdk/
│   ├── __init__.py             # Public re-exports
│   ├── http_client.py          # PhoenixHttpClient (async, 10 REST endpoints)
│   ├── ws_client.py            # PhoenixWsClient (WebSocket with auto-reconnect)
│   ├── tx_builder.py           # PhoenixTxBuilder (Solana transaction builder)
│   ├── ix.py                   # Low-level Solana instruction builders
│   ├── trader_key.py           # TraderKey and PDA derivation
│   ├── config.py               # PhoenixEnv (env var loading)
│   ├── errors.py               # PhoenixHttpError, PhoenixWsError, ApiError, ConnectionFailed, etc.
│   └── models/
│       ├── core.py             # PhoenixModel base, Decimal, Price, Side, PaginatedResponse
│       ├── exchange.py         # ExchangeKeysView, ExchangeMarketConfig, ExchangeResponse
│       ├── market.py           # MarketStatus, RiskState, RiskTier enums
│       ├── trader.py           # TraderView, TraderPositionView, LimitOrder, TraderStateResponse
│       ├── candles.py          # ApiCandle, CandlesQueryParams
│       ├── trades.py           # TradeHistoryItem, TradeHistoryQueryParams
│       ├── collateral.py       # CollateralEvent, CollateralHistoryQueryParams/Response
│       ├── funding.py          # FundingHistoryEvent, FundingHistoryQueryParams/Response
│       ├── orders.py           # OrderHistoryItem, OrderHistoryQueryParams
│       └── ws.py               # WebSocket protocol models
├── tests/
│   ├── conftest.py             # Shared test fixtures
│   ├── test_client.py          # Client endpoint tests (mocked HTTP via respx)
│   ├── test_models.py          # Model deserialization tests
│   ├── test_config.py          # Env var loading tests
│   └── test_ws_client.py       # WebSocket client tests
└── examples/
    ├── get_markets.py
    ├── subscribe_l2_book.py
    ├── send_market_order.py
    ├── send_limit_order.py
    ├── cancel_order.py
    └── deposit_funds.py
```

### Build Commands

```bash
cd python
pip install -e ".[dev]"    # Install with dev dependencies
pytest tests/              # Run tests
```

### phoenix_sdk (Python)

- **http_client** - `PhoenixHttpClient` async HTTP client wrapping all 10 REST endpoints; supports `x-api-key` auth; async context manager for cleanup
- **ws_client** - `PhoenixWsClient` WebSocket client with auto-reconnect, subscription management, and receiver-based event streaming
- **tx_builder** - `PhoenixTxBuilder` high-level transaction builder wrapping low-level instruction builders for Solana
- **ix** - Low-level Solana instruction builders for Phoenix perpetuals (mirrors Rust `phoenix-ix`)
- **trader_key** - `TraderKey` identification and PDA derivation for Phoenix
- **config** - `PhoenixEnv` loads `PHOENIX_API_URL` and `PHOENIX_API_KEY` from environment
- **errors** - `PhoenixHttpError` base with `ApiError` (non-2xx), `RequestFailed` (network), `ParseFailed` (JSON); `PhoenixWsError` with `ConnectionFailed`, `SubscriptionClosed`
- **models** - Pydantic v2 models with camelCase alias generation matching the Rust/JSON wire format; query param builders with `with_*()` chaining

## Additional Agent Docs

- [`rust/sdk/AGENTS.md`](./rust/sdk/AGENTS.md) — Architecture guide for `PhoenixClient`, `PhoenixWSClient`, and `PhoenixHttpClient`. Covers the three-layer client hierarchy, callback-based subscription patterns, cached state getters, lifecycle management, and internal design (command channels, `SubscriptionHandles`, `AggChannels`).
