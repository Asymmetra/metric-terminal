# Metric Terminal

A high-performance perpetuals trading terminal targeting [Imperial](https://api.imperial.space/api/v1/docs) on Solana — a passthrough router that brokers trades across Phoenix, Jupiter, Flash Trade, and GMTrade with isolated-margin profiles. Built with a Rust/Axum backend and Next.js frontend.

> **Fork note:** This is a fork of Ember Terminal (a Phoenix-Rise SDK PoC). The Phoenix-specific backend has been retargeted to Imperial; the swap is in progress (see the migration plan). Documentation below still describes some Ember/Phoenix-era behavior that Phase C/D will rewrite.

## Live Deployment

- **Frontend**: https://ember-terminal-gamma.vercel.app
- **Backend**: https://ember-backend-q4nf.onrender.com
- **WebSocket**: wss://ember-backend-q4nf.onrender.com/ws

## Markets

| Market | Asset ID | Max Leverage | Notes |
|--------|----------|-------------|-------|
| SOL-PERP | 0 | 15x | |
| BTC-PERP | 1 | 20x | |
| ETH-PERP | 2 | 20x | |
| XRP-PERP | 3 | 15x | |
| HYPE-PERP | 4 | 10x | |
| SKR-PERP | 5 | 3x | **Isolated margin only** |
| BNB-PERP | 6 | 10x | |
| DOGE-PERP | 7 | 10x | |
| AAVE-PERP | 8 | 10x | |
| SUI-PERP | 9 | 10x | |
| ZEC-PERP | 10 | 10x | |
| TAO-PERP | 11 | 5x | |

## What It Does

Ember Terminal connects directly to Phoenix's on-chain perpetuals markets and provides:

- **Live orderbook** with depth visualization and dynamic row scaling
- **Real-time price chart** powered by Lightweight Charts (TradingView engine)
- **Collateral-first order entry** (Jupiter-style) — enter USDC collateral + leverage, position size computed automatically
- **Market & limit orders** — transactions built server-side, signed via Phantom wallet
- **TP/SL bracket orders** — take-profit and stop-loss levels auto-placed with each position
- **Isolated margin trading** with subaccount management (subaccounts 1–100; index 0 = cross-margin)
- **Isolated-only markets** — SKR and any future isolated-only markets force isolated mode; cross-margin attempts return 400
- **Phoenix activation state** — detects unactivated wallets (flags < 63) and shows actionable onboarding UI instead of silently failing
- **Dynamic subaccount collateral** — CollateralModal displays true effective collateral per subaccount (not per-position allocated margin)
- **Position management** — view open positions, close individual or close all with confirmation
- **Deposit/withdraw USDC** collateral directly from the terminal
- **Portfolio summary bar** — collateral, unrealized PnL, portfolio value, margin usage
- **Leaderboard** — `/leaderboard` page with trader rankings
- **Analytics** — `/analytics` page with account performance metrics
- **Multi-market switching** with instant data refresh (no stale state)
- **Resizable panels** — drag to resize any section, layout persists across sessions
- **WebSocket streaming** — orderbook, trades, stats, and trader state update in real time
- **Slippage protection** — configurable max slippage (200bps default, 500bps for close-all) on all 4 market order paths
- **Error boundaries** — independent crash isolation for Chart, Orderbook, Order Entry, and Positions sections with retry
- **Trade deduplication** — 30-second guard preventing duplicate transaction submissions across all 9 TX paths
- **Wallet connect** with Phantom

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│  Next.js 15 · React 19 · Zustand · Lightweight Charts   │
│  Phantom Wallet Adapter · TailwindCSS 4                 │
└──────────┬──────────────────────┬───────────────────────┘
           │ REST (HTTPS)         │ WebSocket (WSS)
           ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│                   Ember Backend                         │
│              Rust · Axum · Tokio                         │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ REST Routes  │  │  WS Handler  │  │  TX Builder   │  │
│  │ /api/*       │  │  /ws         │  │  (instructions│  │
│  │ markets,     │  │  orderbook,  │  │   for Phantom │  │
│  │ orderbook,   │  │  trades,     │  │   to sign)    │  │
│  │ trader,      │  │  stats,      │  │               │  │
│  │ candles      │  │  trader_     │  │               │  │
│  │              │  │  margin      │  │               │  │
│  └──────┬───── ┘  └──────┬──────┘  └───────────────┘  │
│         │                │                              │
│         ▼                ▼                              │
│  ┌─────────────────────────────────────────────────┐    │
│  │      Phoenix Rise SDK (crates.io: phoenix-rise)  │    │
│  └──────────────────────┬──────────────────────────┘    │
└─────────────────────────┼───────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │   Phoenix Protocol    │
              │   Solana Mainnet      │
              └───────────────────────┘
```

**Key design decisions:**

- **Backend builds, frontend signs** — the Rust backend constructs transaction instructions using the Phoenix SDK. The frontend deserializes them, simulates via RPC, and the user signs with Phantom. Private keys never leave the wallet.
- **No local database** — Phoenix on-chain state is the source of truth. REST fetches current state, WebSocket streams updates into Zustand stores.
- **SDK WebSocket relay** — the backend maintains a persistent upstream WS connection to Phoenix and fans out updates to all connected browser clients.

## API Surface

### Data Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/markets` | All markets with `isolatedOnly` and `maxLeverage` fields per market |
| `GET /api/orderbook/:symbol` | Live orderbook |
| `GET /api/candles/:symbol` | OHLCV candlestick data |
| `GET /api/trader/:pubkey` | Trader account state |

### Transaction Endpoints

All transaction endpoints are under `/api/tx/`:

| Endpoint | Description |
|----------|-------------|
| `POST /api/tx/market-order` | Cross-margin market order |
| `POST /api/tx/limit-order` | Cross-margin limit order |
| `POST /api/tx/isolated-market-order` | Isolated margin market order — **requires `subaccount_index` (1–100)** |
| `POST /api/tx/isolated-limit-order` | Isolated margin limit order — **requires `subaccount_index` (1–100)** |
| `POST /api/tx/cancel-orders` | Cancel open orders |
| `POST /api/tx/deposit` | Deposit USDC collateral |
| `POST /api/tx/withdraw` | Withdraw USDC collateral |
| `POST /api/tx/transfer-collateral` | Transfer collateral between subaccounts |
| `POST /api/tx/register-subaccount` | Register a new isolated margin subaccount |
| `POST /api/tx/place-multi-limit-orders` | Batch multiple limit orders (up to 10) in one transaction |
| `POST /api/tx/cancel-stop-loss` | Cancel a specific TP/SL bracket leg by direction |

> **Note:** `/api/tx/isolated-limit-order` and `/api/tx/isolated-market-order` require an explicit `subaccount_index` field (integer 1–100). Omitting it returns `400 Bad Request`.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, TypeScript, TailwindCSS 4 |
| State | Zustand 5 (8 stores: market, orderbook, stats, trade, trader, tradeDetail, toast, ui) |
| Charts | Lightweight Charts 4 (TradingView engine) |
| Wallet | Phantom via @solana/wallet-adapter-react |
| Backend | Rust, Axum 0.8, Tokio, Tower-HTTP |
| SDK | [`phoenix-rise`](https://crates.io/crates/phoenix-rise) (Rust crate from crates.io) |
| Chain | Solana mainnet |
| Layout | react-resizable-panels with localStorage persistence |

## Repo Structure

```
ember-terminal/
├── ember-backend/              # Rust/Axum API server
│   └── src/
│       ├── main.rs             # Server entrypoint, CORS, routing
│       ├── config.rs           # Environment-based configuration
│       ├── routes/             # REST endpoints
│       │   ├── markets.rs      # GET /api/markets, /api/markets/:symbol
│       │   ├── orderbook.rs    # GET /api/orderbook/:symbol
│       │   ├── trader.rs       # GET /api/trader/:pubkey
│       │   ├── trade.rs        # POST /api/tx/* (market, limit, cancel, deposit, withdraw)
│       │   └── candles.rs      # GET /api/candles/:symbol
│       ├── ws/                 # WebSocket server
│       │   ├── handler.rs      # Client connection management
│       │   ├── relay.rs        # Upstream Phoenix WS → client fan-out
│       │   └── messages.rs     # Subscribe/unsubscribe protocol
│       ├── services/           # Business logic
│       │   ├── tx_builder.rs   # Transaction instruction construction
│       │   ├── broadcast.rs    # WS broadcast channels
│       │   └── market_cache.rs # In-memory market data cache
│       └── phoenix/            # SDK type wrappers
│
├── ember-frontend/             # Next.js trading terminal UI
│   └── src/
│       ├── app/                # Next.js app router (landing + terminal + leaderboard + analytics)
│       ├── components/
│       │   ├── landing/        # Landing page (particle animation, hero)
│       │   └── terminal/       # Trading terminal components
│       │       ├── Chart.tsx              # Price chart (Lightweight Charts)
│       │       ├── Orderbook.tsx          # Live orderbook with depth bars
│       │       ├── OrderEntry.tsx         # Collateral-first order form
│       │       ├── Positions.tsx          # Open positions + orders, close buttons
│       │       ├── TradeHistory.tsx       # Recent trades feed
│       │       ├── MarketHeader.tsx       # Market selector, stats
│       │       ├── PortfolioSummaryBar.tsx # Portfolio metrics bar
│       │       └── DepositWithdraw.tsx    # USDC deposit/withdraw modal
│       ├── stores/             # Zustand state management
│       ├── hooks/              # Custom hooks (WS, trader sync, tx builder)
│       └── lib/                # Utilities (API client, WS client, formatting)
│
├── Dockerfile                  # Multi-stage Rust build for production
├── render.yaml                 # Render Blueprint (backend deployment)
└── .gitignore
```

## Local Development

### Prerequisites

- **Rust** (1.75+) — [rustup.rs](https://rustup.rs)
- **Node.js** (20+) — [nodejs.org](https://nodejs.org)
- **Solana RPC URL** — free tier from [Helius](https://helius.dev), [QuickNode](https://quicknode.com), or similar (public RPC rate-limits transaction flows)

### Backend

```bash
cd ember-backend

# No env vars required for defaults (Phoenix public API, port 3001)
# Optional: CORS_ORIGIN, PHOENIX_API_KEY, RUST_LOG
cargo run
```

The backend starts on `http://localhost:3001`. Health check: `GET /health`.

### Frontend

```bash
cd ember-frontend
npm install

# Create .env.local with your RPC URL
cat > .env.local << 'EOF'
NEXT_PUBLIC_SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
EOF

npm run dev
```

Open `http://localhost:3000`. The landing page loads first — click **IGNITE TERMINAL** to enter the trading interface.

## Deployment

Ember is designed for **Vercel** (frontend) + **Render** (backend). The backend requires persistent WebSocket connections, which rules out serverless platforms.

### 1. Deploy Backend on Render

1. Go to [render.com](https://render.com) → **New** → **Blueprint**
2. Connect the `devli13/ember-terminal` GitHub repo
3. Render auto-discovers `render.yaml` and provisions the service
4. Set the `CORS_ORIGIN` environment variable to your Vercel domain (e.g. `https://ember-terminal-gamma.vercel.app`)
5. Deploy — Render builds the Docker image and starts the service

Your backend URL will be something like `https://ember-backend-xxxx.onrender.com`.

### 2. Deploy Frontend on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project** → import the repo
2. Set **Root Directory** to `ember-frontend`
3. Add environment variables:
   - `NEXT_PUBLIC_API_URL` = `https://ember-backend-xxxx.onrender.com`
   - `NEXT_PUBLIC_WS_URL` = `wss://ember-backend-xxxx.onrender.com/ws`
   - `NEXT_PUBLIC_SOLANA_RPC` = your Solana RPC URL
4. Deploy

### Ongoing Updates

After initial setup, both platforms auto-deploy on `git push origin main`. No manual intervention needed.

## Environment Variables

### Backend (runtime)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port (Render uses 10000) |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed origin(s), comma-separated |
| `PHOENIX_API_URL` | `https://perp-api.phoenix.trade` | Phoenix REST API |
| `PHOENIX_WS_URL` | `wss://perp-api.phoenix.trade/ws` | Phoenix WebSocket |
| `PHOENIX_API_KEY` | — | Optional API key |
| `RUST_LOG` | `ember_backend=info` | Log level filter |

### Frontend (build-time)

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | Backend REST URL |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:3001/ws` | Backend WebSocket URL |
| `NEXT_PUBLIC_SOLANA_RPC` | — | Solana RPC endpoint (required) |

> **Note:** `NEXT_PUBLIC_*` variables are baked in at build time. Changing them requires a redeploy.

## How Trading Works

1. User connects Phantom wallet
2. Frontend fetches trader account data from backend (which queries Phoenix SDK)
3. User enters USDC collateral amount and leverage multiplier — position size is computed automatically
4. User selects order type (market or limit), side (long/short), and optionally sets TP/SL levels
5. Backend builds the transaction instructions using Phoenix SDK
6. Frontend deserializes instructions, simulates the transaction via Solana RPC
7. Phantom prompts the user to sign
8. Signed transaction is sent to Solana
9. Frontend confirms the transaction on-chain, then refreshes trader state
10. WebSocket streams deliver real-time updates for positions, orderbook, and trades

## Testing

The automated E2E suite (`tests/e2e-expanded.mjs`) runs 30 tests against the live production backend using a funded test wallet. It covers the full trade lifecycle with real on-chain transactions across all 12 markets.

```bash
cd tests
npm install
node e2e-expanded.mjs
```

**What it tests:**
- Section A (tests 1–8): Multi-market cross-margin orders (ETH, XRP, BTC, HYPE)
- Section B (tests 9–14): Isolated subaccount registration and SOL trading
- Section C (tests 15–18): Cross↔isolated collateral transfers and sweep
- Section D (tests 19–24): Edge cases — subaccount re-registration, isolated limit/cancel, required-field guards (400), SKR isolated-only enforcement, final state verification
- Section E (tests 25–30): New market coverage (DOGE, AAVE, SUI, ZEC, TAO, BNB) — orderbook + limit order per market

Expected output: `30/30 PASS`, wallet returns to its starting collateral balance, zero open orders/positions.

> **Note:** Tests use a pre-funded test wallet on Solana mainnet. Runs cost real gas. Do not run repeatedly in a tight loop.

## Known Limitations

| Area | Detail |
|------|--------|
| Activation state check | Uses `flags >= 63` rather than strict bitmask `(flags & 63) === 63`. Works correctly for Phoenix's current sequential activation lifecycle; would misclassify a wallet if Phoenix ever sets non-sequential high bits without first setting all lower bits. Low practical risk. |
| Collateral state propagation | After a `transfer-collateral` transaction confirms, `/api/trader/` may return stale balances for ~5–10 seconds. The UI reflects the lag until the next WebSocket-triggered refresh. |
| Frontend E2E coverage | The automated test suite (`tests/e2e-expanded.mjs`) covers the full backend/API layer with real on-chain transactions. UI-specific features (activation state display, CollateralModal balance) are verified by code review; no browser-driven test harness exists yet. |

## Future Work

Features planned but not yet implemented, roughly by priority:

- **Invite code registration flow** — modal for new wallets to enter invite/referral code before trading (SDK support confirmed, proposal drafted)
- **Testnet toggle** — switch between mainnet and Phoenix devnet without code changes
- **Sub-account dashboard** — dedicated `/accounts` page showing per-subaccount collateral, positions, and transfer UI
- **Advanced orders** — trailing stops, bracket orders with multiple TP levels, OCO
- **Copy trading** — follow and mirror another trader's positions in real time
- **Competitions** — time-boxed PnL leaderboards with opt-in entry
- **PWA / mobile** — installable app with responsive layout for mobile trading

## License

MIT
