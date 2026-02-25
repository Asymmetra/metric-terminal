# Ember Terminal

A high-performance perpetuals trading terminal for [Phoenix](https://phoenix.trade) on Solana. Built with a Rust/Axum backend and Next.js frontend, Ember brings a Bloomberg-grade trading experience to on-chain perpetual futures.

## What It Does

Ember Terminal connects directly to Phoenix's on-chain perpetuals markets (SOL-PERP, ETH-PERP) and provides:

- **Live orderbook** with depth visualization and dynamic row scaling
- **Real-time price chart** powered by Lightweight Charts (TradingView engine)
- **Market & limit order placement** — transactions built server-side, signed via Phantom wallet
- **Position management** — view open positions, close individual or close all with confirmation
- **Deposit/withdraw USDC** collateral directly from the terminal
- **Portfolio overview** — collateral, unrealized PnL, portfolio value, margin usage in the top bar
- **Multi-market switching** with instant data refresh (no stale state)
- **Resizable panels** — drag to resize any section, layout persists across sessions
- **WebSocket streaming** — orderbook, trades, stats, and trader state update in real time

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
│  │            Phoenix Rise SDK (Rust)               │    │
│  │  phoenix-sdk · phoenix-types · phoenix-ix        │    │
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

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, TypeScript, TailwindCSS 4 |
| State | Zustand 5 (6 stores: market, orderbook, stats, trade, trader, toast) |
| Charts | Lightweight Charts 4 (TradingView engine) |
| Wallet | Phantom via @solana/wallet-adapter-react |
| Backend | Rust, Axum 0.8, Tokio, Tower-HTTP |
| SDK | Phoenix Rise SDK (local Rust crate — phoenix-sdk, phoenix-types, phoenix-ix) |
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
│       ├── app/                # Next.js app router (landing + terminal pages)
│       ├── components/
│       │   ├── landing/        # Landing page (particle animation, hero)
│       │   └── terminal/       # Trading terminal components
│       │       ├── Chart.tsx           # Price chart (Lightweight Charts)
│       │       ├── Orderbook.tsx       # Live orderbook with depth bars
│       │       ├── OrderEntry.tsx      # Order form (market/limit, leverage)
│       │       ├── Positions.tsx       # Open positions + orders, close buttons
│       │       ├── TradeHistory.tsx    # Recent trades feed
│       │       ├── MarketHeader.tsx    # Market selector, stats, portfolio bar
│       │       └── DepositWithdraw.tsx # USDC deposit/withdraw modal
│       ├── stores/             # Zustand state management
│       ├── hooks/              # Custom hooks (WS, trader sync, tx builder)
│       └── lib/                # Utilities (API client, WS client, formatting)
│
├── phoenix-rise-sdk/           # Phoenix SDK (Rust, local dependency)
│   └── rust/
│       ├── sdk/                # Core SDK crate
│       ├── types/              # Protocol type definitions
│       └── ix/                 # Instruction builders
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
4. Set the `CORS_ORIGIN` environment variable to your Vercel domain (e.g. `https://ember-terminal.vercel.app`)
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
| `PHOENIX_API_URL` | `https://public-api.phoenix.trade` | Phoenix REST API |
| `PHOENIX_WS_URL` | `wss://public-api.phoenix.trade/ws` | Phoenix WebSocket |
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
3. User submits an order (market or limit) via the order entry form
4. Backend builds the transaction instructions using Phoenix SDK
5. Frontend deserializes instructions, simulates the transaction via Solana RPC
6. Phantom prompts the user to sign
7. Signed transaction is sent to Solana
8. Frontend confirms the transaction on-chain, then refreshes trader state
9. WebSocket streams deliver real-time updates for positions, orderbook, and trades

## License

MIT
