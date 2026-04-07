# TypeScript SDK - Module Architecture

TypeScript/JavaScript SDK for the Phoenix perpetuals exchange. Built on the Solana JavaScript kit with modular, composable instruction builders and WebSocket client.

## Directory Structure

```
ts/
├── src/
│   ├── accounts/              # Account fetching and caching
│   │   ├── accountFetchers.ts # Individual account fetch functions
│   │   ├── fetcherFactory.ts  # Factory for creating account fetchers
│   │   └── index.ts
│   ├── api/                   # HTTP API clients (generated)
│   │   ├── candles/
│   │   ├── collateral/
│   │   ├── exchange/
│   │   ├── funding/
│   │   ├── invite/
│   │   ├── markets/
│   │   ├── notifications/
│   │   ├── orders/
│   │   ├── traders/
│   │   ├── trades/
│   │   └── types/             # Shared API types
│   ├── auth/                  # Authentication and session management
│   │   ├── client.ts          # Auth client interface
│   │   ├── manager.ts         # Session manager
│   │   ├── session.ts         # Session types and handling
│   │   ├── runtime.ts         # Runtime auth flow
│   │   ├── storage.ts         # Token storage interface
│   │   ├── backoff.ts         # Retry backoff logic
│   │   ├── debug.ts           # Debug utilities
│   │   ├── types.ts           # Auth configuration types
│   │   └── index.ts
│   ├── core/                  # Core instruction builders and helpers
│   │   ├── ixBuilders/        # Individual instruction builder modules
│   │   │   ├── CancelAll.ts
│   │   │   ├── CancelOrdersById.ts
│   │   │   ├── CancelStopLoss.ts
│   │   │   ├── CreateEscrowRequest.ts
│   │   │   ├── DelegateTrader.ts
│   │   │   ├── DepositFunds.ts
│   │   │   ├── EmberDeposit.ts
│   │   │   ├── EmberWithdraw.ts
│   │   │   ├── PlaceLimitOrder.ts
│   │   │   ├── PlaceMarketOrder.ts
│   │   │   ├── PlacePostOnlyOrder.ts
│   │   │   ├── PlaceStopLoss.ts
│   │   │   ├── RegisterTrader.ts
│   │   │   ├── SyncParentToChild.ts
│   │   │   ├── TransferCollateral.ts
│   │   │   ├── TransferCollateralChildToParent.ts
│   │   │   ├── WithdrawFunds.ts
│   │   │   └── index.ts
│   │   ├── clientTypes.ts     # Client type definitions
│   │   ├── constants.ts       # Program IDs, instruction addresses
│   │   ├── discriminants.ts   # Instruction discriminants
│   │   ├── helpers.ts         # Utility functions for account fetching, conversions
│   │   ├── permissionInstructions.ts # Permission instruction builders
│   │   └── index.ts
│   ├── generated/             # Code-generated files
│   │   └── routeCatalog.ts    # Route metadata
│   ├── http/                  # HTTP transport layer
│   │   ├── transport.ts       # HTTP request handler
│   │   └── index.ts
│   ├── margin/                # Margin calculation utilities
│   │   ├── constants.ts
│   │   ├── index.ts
│   │   └── types.ts
│   ├── primitives/            # Type-safe primitives
│   │   ├── index.ts           # Main exports (Authority, Side, Symbol, etc.)
│   │   ├── direction.ts
│   │   ├── enums.ts           # Enums (MarginType, OrderFlags, etc.)
│   │   └── ...
│   ├── types/                 # Shared data types
│   │   ├── index.ts
│   │   ├── market.ts          # Market-related types
│   │   └── trader.ts          # Trader state types
│   ├── ws/                    # WebSocket client and adapters
│   │   ├── PhoenixWsClient.ts # Main WS client
│   │   ├── url.ts             # URL utilities
│   │   ├── adapters/          # Data adapters
│   │   │   ├── all-mids/
│   │   │   ├── candles/
│   │   │   ├── exchange-status/
│   │   │   ├── fills/
│   │   │   ├── funding-rate/
│   │   │   ├── l2-book/
│   │   │   ├── mark-price/
│   │   │   ├── market/
│   │   │   ├── market-stats/
│   │   │   ├── notifications/
│   │   │   ├── orderbook/
│   │   │   ├── trader-state/
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── builders.ts            # High-level transaction builders
│   ├── client.ts              # PhoenixHttpClient (HTTP API wrapper)
│   ├── clientIdentity.ts      # User-Agent and client identification
│   ├── errors.ts              # Error types
│   ├── flows.ts               # Multi-step flows (deposit, withdraw, etc.)
│   ├── pdas.ts                # PDA derivation utilities
│   └── index.ts               # Main entry point (public API)
├── tests/                     # Test suites
│   ├── builders/
│   ├── core/
│   ├── flows/
│   ├── margin/
│   ├── primitives/
│   ├── ws/
│   └── ...
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── tsdown.config.ts          # Build configuration
```

## Module Organization

### HTTP API (`api/`)

Generated HTTP client modules for each API endpoint group:
- **candles** - Fetch historical OHLCV data
- **exchange** - Fetch exchange configuration and metadata
- **markets** - Fetch market data and order books
- **traders** - Fetch trader positions and state
- **orders** - Query order history
- **trades** - Query trade history
- **funding** - Fetch funding rate data
- **collateral** - Fetch collateral events and history
- **invite** - Manage trader registration invites
- **notifications** - Manage user notifications

### WebSocket Client (`ws/`)

Real-time data streaming with type-safe adapters:
- **PhoenixWsClient** - Main WebSocket client with subscription management
- **Adapters** - Typed message handlers for each data stream:
  - `L2BookAdapter` - Order book updates
  - `MarketStatsAdapter` - Market statistics (mark price, volume, funding)
  - `CandlesAdapter` - OHLCV candles
  - `TraderStateAdapter` - Trader positions and collateral
  - `FillsAdapter` - Trade execution events
  - `FundingRateAdapter` - Funding rate changes
  - `AllMidsAdapter` - Mid prices across all markets
  - `NotificationsAdapter` - Server notifications
  - `ExchangeStatusAdapter` - Exchange operational status

### Instruction Builders (`core/ixBuilders/`)

Modular Solana instruction builders for all operations:
- **Order placement** - Market, limit, post-only, stop-loss orders
- **Order cancellation** - Cancel by ID or all orders
- **Deposits/withdrawals** - Deposit USDC via Ember, withdraw back to USDC
- **Trader management** - Register subaccounts, delegate authorities
- **Collateral transfers** - Move collateral between margin types
- **Escrow** - Create and manage escrow requests

### Flows (`flows.ts`)

High-level multi-step operations composing multiple instructions:
- `depositFlow()` - Create ATA, deposit via Ember, fund Phoenix
- `withdrawFlow()` - Create ATA, approve token transfer, withdraw, unwrap
- `depositAndPlaceOrderFlow()` - Combined deposit and order placement
- `withdrawalWithSlippageFlow()` - Withdrawal with slippage tolerance

### Builders (`builders.ts`)

Transaction construction functions that compose instruction builders. Export individual builder functions for:
- Market orders (`buildPlaceMarketOrderIx`)
- Limit orders (`buildPlaceLimitOrderIx`)
- Order cancellation (`buildCancelOrdersByIdIx`)
- Fund deposits/withdrawals (`buildDepositFundsIx`, `buildWithdrawFundsIx`)
- Trader registration (`buildRegisterTraderIx`)
- And many more...

### HTTP Client (`client.ts`)

Unified HTTP API client exposing all endpoint groups:
- `PhoenixHttpClient` - Main class with properties for each API group
- `createPhoenixClient()` - Factory for creating client with auth and config
- Automatic auth token refresh and request signing

### Authentication (`auth/`)

Complete authentication flow for session management:
- **session.ts** - Session types and token storage
- **runtime.ts** - Active session management
- **manager.ts** - User-facing session API
- **client.ts** - Auth service client
- **storage.ts** - Token persistence interface
- **backoff.ts** - Retry and backoff strategies

### Core Utilities (`core/`)

Low-level instruction and account management:
- **helpers.ts** - Account fetching, market/symbol lookups, conversions
- **constants.ts** - Program IDs, instruction addresses, fees
- **clientTypes.ts** - Type definitions for pluggable client implementations
- **permissionInstructions.ts** - Permission-related instruction builders

### Type-Safe Primitives (`primitives/`)

Newtype wrappers and enums for type safety:
- `Authority`, `Symbol`, `Direction`, `MarketAddress`
- `BaseLots`, `QuoteLots`, `Ticks` (type-safe quantity system)
- `Side`, `OrderFlags`, `MarginType`
- Conversion utilities between primitive types

### Margin Calculations (`margin/`)

Margin requirement and liquidation calculations:
- Leverage tier lookup
- Maintenance and initial margin computation
- Cross-collateral and isolated margin handling
