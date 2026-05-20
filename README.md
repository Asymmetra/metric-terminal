# Metric Terminal

A high-performance perpetuals trading terminal targeting [Imperial](https://api.imperial.space/api/v1/docs) on Solana — a passthrough router that brokers trades across Phoenix, Jupiter, Flash Trade, and GMTrade with isolated-margin profiles (0..5 per wallet). Built with a Rust/Axum backend and Next.js frontend.

> This is a fork of Ember Terminal (originally a Phoenix-Rise SDK PoC). Every Phoenix-Rise-shaped code path has been ripped out and replaced with calls against Imperial's HTTP/WS API. Imperial integrates Phoenix as one of its four underwriters; you'll see Phoenix referenced where Imperial's own surface exposes it (e.g. `/phoenix/depth`, `/phoenix/register`, `underwriter: 2`), and nowhere else.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind v4, Zustand |
| Wallet  | `@solana/wallet-adapter-react` (Phantom) abstracted behind a `SignerProvider` so a Privy + paymaster signer can drop in for production |
| Backend | Rust 2021, Axum 0.8, Tokio, `reqwest`, `tokio-tungstenite` |
| Upstream | Imperial REST + WS at `https://api.imperial.space` / `wss://api.imperial.space` |
| Chain | Solana mainnet |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                       Browser                            │
│  Next.js · Phantom wallet · SignerProvider abstraction   │
│  Direct HTTP to Imperial for JWT-authed /mobile/* paths  │
└────────┬─────────────────────────────────────────────────┘
         │                          │
   ws://metric-backend/ws       https://api.imperial.space/api/v1/mobile/*
         │                          │
┌────────▼─────────────────┐        │
│   Metric Backend (Rust)  │        │
│  WS fan-out from upstream│        │
│  Candle aggregation      │        │
│  Market-list normalization│       │
│  /deposit/build-tx proxy │        │
└────────┬─────────────────┘        │
         │                          │
   https://api.imperial.space (REST + WS)
         │
┌────────▼──────────────────────────────────────────────────┐
│              Imperial — perps router                      │
│   Jupiter · Flash Trade · Phoenix · GMTrade               │
└───────────────────────────────────────────────────────────┘
```

**Design calls:**

- **Backend never signs.** Every tx-building endpoint returns an unsigned tx (today: only `/api/tx/deposit` and `/api/tx/withdraw`, which proxy Imperial's `/deposit/build-tx` partially-signed `VersionedTransaction`). The client signs with Phantom in the PoC, with Privy + paymaster in production.
- **Order placement bypasses the backend.** Imperial's `/mobile/orders` is JWT-delegated per-wallet. The frontend's `ImperialClient` calls Imperial directly so the backend never holds a per-wallet JWT. Backend's role is upstream WS fan-out (one connection serves N browsers), candle aggregation (Imperial has no candles endpoint), and the unauthed `/deposit/build-tx` passthrough.
- **Imperial WS event shape**: `/ws/market` uses `snake_case` on the wire even though the OpenAPI docs show camelCase. The backend mirrors snake_case in `MarketEvent` and rewrites to camelCase when fanning out to browser clients.

## Repo layout

```
metric-backend/
├── src/
│   ├── main.rs              boot, CORS, /health{,/relay,/memory}, /ws upgrade
│   ├── state.rs             AppState: ImperialHttp + BroadcastHub + CandleAggregator + MarketCache
│   ├── config.rs            IMPERIAL_API_URL, IMPERIAL_WS_URL, PORT
│   ├── error.rs             AppError → IntoResponse (502 for upstream, 410 Gone for deprecated)
│   ├── imperial/
│   │   ├── http.rs          REST: mark-prices, funding, per-venue markets,
│   │   │                    phoenix/depth, positions, trades, route,
│   │   │                    priority-fee, deposit/build-tx
│   │   ├── ws.rs            /ws/market client with reconnect + app-level ping
│   │   ├── candles.rs       1m/5m/15m/1h OHLCV from the mark-price stream
│   │   ├── types.rs         DTOs derived from openapi.json
│   │   └── error.rs         ImperialError + IntoResponse
│   ├── routes/              public REST surface (see below)
│   ├── services/            BroadcastHub, MarketCache
│   └── ws/                  /ws relay + per-client multiplex handler

metric-frontend/
├── src/
│   ├── app/
│   │   ├── page.tsx         landing
│   │   ├── imperial/        the working trading demo
│   │   ├── status/          health-status view
│   │   └── layout.tsx       root layout with WalletProvider
│   ├── components/
│   │   ├── health/HealthPanel.tsx
│   │   └── landing/{HeroSection,MetricParticles}.tsx
│   ├── lib/
│   │   ├── wallet/          SignerProvider + Phantom + Privy stub + useSigner
│   │   ├── imperial/        ImperialClient + types + jwt cache + ws adapters
│   │   ├── constants.ts     API_BASE_URL, WS_URL
│   │   └── format.ts
│   └── providers/WalletProvider.tsx

tests/
├── e2e-imperial.mjs         backend integration suite (10 checks, runs against local metric-backend)
├── imperial-live.mjs        live Imperial suite: T1 auth+reads, T2 deposit, T3 order place+cancel
├── signing-local.mjs        Solana signing path validation (no Imperial needed)
└── mock-imperial-server.mjs minimal Imperial mock for offline integration testing
```

## API surface (metric-backend)

| Method | Path | Notes |
|--------|------|-------|
| GET    | /health, /health/relay, /health/memory | observability |
| GET    | /api/markets | aggregated from `/phoenix/markets` + `/flash/markets` + `/gmtrade/markets`; resilient to per-venue failure |
| GET    | /api/orderbook/:symbol | proxies `/phoenix/depth` (other venues are AMM, return null) |
| GET    | /api/candles/:symbol?venue=...&timeframe=... | served from in-process CandleAggregator |
| GET    | /api/trades/:wallet | proxies Imperial `/trades?walletAddress=` — your position lifecycles |
| GET    | /api/trader/:wallet[/{positions,trades}] | proxies Imperial `/positions`, `/trades` |
| POST   | /api/tx/deposit, /api/tx/withdraw | proxies `/deposit/build-tx`, returns base64 partial tx |
| POST   | /api/tx/{market-order,limit-order,cancel-orders,…} | 410 Gone — call `https://api.imperial.space/api/v1/mobile/*` directly from the signed-in client |
| GET    | /ws | fan-out from Imperial `/ws/market` (mark + funding + depth, mirrored as `mark_prices:{sym}` / `funding_rates:{sym}` / `phoenix_depth:{sym}` channels) and synthetic `candles:{sym}` 1m bars |

## Local development

### Prerequisites

- Rust 1.75+ — [rustup.rs](https://rustup.rs)
- Node.js 20+ — [nodejs.org](https://nodejs.org)
- Solana RPC endpoint (Helius / QuickNode recommended for live trade tests)

### Run

```bash
# Backend (port 3001)
cd metric-backend
cargo run

# Frontend (port 3000)
cd metric-frontend
npm install
npm run dev
```

Open <http://localhost:3000>. The hero CTA goes to `/imperial`, the working demo route.

### Tests

```bash
# Backend
cd metric-backend
cargo test
cargo clippy -- -D warnings

# Frontend (unit + tsc)
cd metric-frontend
npx tsc --noEmit
npm test                                   # 14 Vitest cases

# Backend integration (boot metric-backend, then)
node tests/e2e-imperial.mjs                # 10 checks against http://127.0.0.1:3457

# Solana signing path (no Imperial needed)
node tests/signing-local.mjs               # 6 checks

# Live against api.imperial.space (test wallet HP29cxeY…)
cd metric-frontend                         # so node resolves @solana/web3.js
node ../tests/imperial-live.mjs            # T1 auth + reads
DEPOSIT=1 SOLANA_RPC=https://… node ../tests/imperial-live.mjs   # +T2 deposit
ORDER=1   SOLANA_RPC=https://… node ../tests/imperial-live.mjs   # +T3 order place + cancel
```

### Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `IMPERIAL_API_URL` | https://api.imperial.space | backend REST upstream |
| `IMPERIAL_WS_URL`  | wss://api.imperial.space  | backend WS upstream |
| `CORS_ORIGIN`      | http://localhost:3000     | comma-separated |
| `RUST_LOG`         | metric_backend=info       | tracing filter |
| `PORT`             | 3001                      | backend listen port |
| `NEXT_PUBLIC_API_URL` | http://localhost:3001 | frontend → backend |
| `NEXT_PUBLIC_WS_URL`  | ws://localhost:3001/ws | frontend → backend WS |
| `NEXT_PUBLIC_IMPERIAL_API_URL` | https://api.imperial.space | frontend → Imperial direct (JWT-authed paths) |
| `NEXT_PUBLIC_SIGNER` | phantom | `phantom` or `privy-stub` |

## Deployment

The current production Render service (`ember-backend-q4nf`) and Vercel project (`ember-terminal-gamma`) are pending rename to `metric-backend` / `metric-terminal`. CSP allowlist in `metric-frontend/vercel.json` will need to add `api.imperial.space` and drop `perp-api.phoenix.trade` once the rename lands.

## License

MIT
