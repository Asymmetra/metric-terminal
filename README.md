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

## Integrating with Imperial — practical notes

Everything below is stuff we hit during this build that isn't obvious from the [OpenAPI](https://api.imperial.space/api/v1/openapi.json) alone. If you're building on Imperial, skim this first — most cost a couple hours of debugging the first time.

### Authentication (the part that bit us hardest)

**Nonce must be a unix timestamp**, not random bytes / UUID / hex. The API accepts any string and only the order bot validates the format, but the API hides which check tripped:

```ts
// ✗ Random hex / UUID → silent 401 "Failed to generate mobile session"
const nonce = crypto.randomBytes(16).toString("hex");

// ✓ Date.now() — seconds or ms both accepted, must be within ±5 min
const nonce = Date.now().toString();

const message   = `imperial:mobile-connect:${wallet}:${nonce}`;
const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), seed));
await fetch(`${IMPERIAL}/api/v1/mobile/connect`, { method:"POST", body: JSON.stringify({ wallet, message, signature }) });
```

Source: `mobile.rs:186-190` (API: accepts any string) vs `http.rs:564-588` (order bot: requires u64-parseable, ±5min). Surfaced via Hunter @ Imperial — not documented anywhere user-facing.

**Signature must be raw ed25519 over UTF-8 bytes** — *not* wrapped in Solana's off-chain-message envelope. Some wallet adapters wrap by default. `wallet.signMessage(new TextEncoder().encode(message))` works with Phantom; verify with a noble-curves probe if using anything else:

```ts
const ok = ed25519.verify(sig, new TextEncoder().encode(message), wallet.toBytes());
```

**Auth flow tl;dr:**
1. `POST /mobile/connect`  →  `{ code }`  (5-min TTL, single-use)
2. `POST /mobile/exchange { code }`  →  `{ jwt, expiresAt }`  (**JWT TTL is 30 days**)
3. `Authorization: Bearer <jwt>` on every `/mobile/*` request — JWT's `wallet` claim must match the `wallet` field in the request body
4. `POST /mobile/revoke` when done

The JWT is a delegation: holding it = the operator can place orders from that wallet's profiles. Treat it like an API key. Multi-wallet bots hold N JWTs in parallel.

### Which endpoints actually need a JWT

| Path | Auth | Notes |
|---|---|---|
| `/api/v1/mobile/*` (balances, orders, orders/batch, cancel, update, collateral) | **JWT** | core trading |
| `/api/v1/deposit/build-tx` | **none** | unsigned tx, wallet-keyed |
| `/api/v1/passthrough/users/{wallet}/profiles/{index}/sync` | **none** | residue-USDC sweep |
| `/api/v1/phoenix/register` | **none** | Phoenix trader activation (also auto-runs on first Phoenix order — usually skip) |
| `/api/v1/positions`, `/trades`, `/orders`, `/mark-prices`, `/funding-rates`, `/route`, `/phoenix/depth`, `/{phoenix,flash,gmtrade}/markets`, `/status`, `/priority-fee` | **none** | all reads |
| `/ws`, `/ws/market` | **none** | also exempt from the 600 req/min rate limit |

If your eng says "trading works without auth", they almost certainly mean **deposit/withdraw work** without auth. **Order placement does not** — `/mobile/orders` is JWT-only, the OpenAPI is unambiguous, no API-key alternative exists.

### Order placement gotchas

- **`HTTP 200` does not mean the order succeeded.** `/mobile/orders` returns 200 once the request was well-formed and the order bot was reachable, even on rejection. **Always check `success: boolean`** and read `error` when false. HTTP 4xx is reserved for malformed input / auth failures; HTTP 5xx for server faults.
- **$10 minimum collateral** — undocumented; you get a 400 `"Minimum collateral is $10; received ~$X.XX"` if you try less. Bump `collateralAmount` to at least `10_000_000` (USDC has 6 decimals).
- **Numeric enum codes:** `side` 0=long / 1=short, `action` 0=Increase / 1=Decrease, `underwriter` 0=Jupiter / 1=Flash / 2=Phoenix / 3=GMTrade, `orderType` 0=Market / 1=Limit / 2=StopLimit (+ exotic 3-16: LandMine, Ratchet, Dca, FibRatchet, DcaTime, DcaRatchet, etc.). See `src/lib/imperial/types.ts` for the full set as named TS consts.
- **`triggerPrice` is in oracle scale (1e9)**, not USD. A SOL limit at $43 = `43 * 1_000_000_000`.
- **`sizeUsd` and `collateralAmount` are 6-decimal fixed point.** $20 notional = `20_000_000`. USDC's native units.
- **`symbol` vs `marketMint`** — pass the canonical symbol (`"SOL"`, `"XAU"`, `"GOLD"`) and Imperial resolves it per-venue. Phoenix synthetics have no SPL mint, so symbol is the only addressable form for them. Explicit `marketMint` still works for venues that have one.
- **`profileIndex` 0..5 only.** Every wallet has six implicit isolated-margin profiles; balances and positions never mix across them. They're created lazily on first `/deposit/build-tx` or first `/mobile/orders`. `/mobile/balances` returns `usdc: 0` for uninitialized profiles without erroring — that's normal, not a provisioning gate.
- **Phoenix orders auto-activate** the trader account on first use. `POST /phoenix/register` is unauthed and idempotent but rarely needed.
- **No inter-profile collateral transfer.** Move USDC between profile 0 and profile 1 by withdrawing to the wallet then depositing into the new profile. Two on-chain hops.
- **Resting orders return `orderPda`.** Cancel and update by `orderPda` — no need to wait for the indexer to catch up.
- **For exotic order types**, the per-type extras live in `extraData` (e.g. Ratchet needs `worstPrice` + `ratchetSize`). Schema is in the OpenAPI but loosely typed.

### `/deposit/build-tx` — the only unsigned-tx path

```ts
const { transaction } = await imperial.buildDepositTx({
  wallet, profileIndex: 0, amount: 1_000_000, mode: "deposit"  // or "withdraw"
});
const vtx = VersionedTransaction.deserialize(Uint8Array.from(atob(transaction), c => c.charCodeAt(0)));
vtx.sign([kp]);                                // ← only the wallet's slot, fee-payer is Imperial
const sig = await rpc.sendTransaction(vtx);
```

The returned VersionedTransaction is *partially signed* — Imperial sponsors the fee-payer half. Your client adds the wallet's signature in the empty signer slot. No `recentBlockhash` regeneration required.

### WebSocket gotchas

- **Two endpoints, both at the root** (`/ws` and `/ws/market`), **not under `/api/v1`**. Easy to miss because the REST surface is `/api/v1/...`.
- **`/ws/market` event payloads use `snake_case` keys**, even though the OpenAPI/REST docs describe the equivalent shapes in `camelCase`. We learned this the hard way — the camelCase MarkPriceUpdate decode failed *silently for funding rates* (Option fields defaulted to None) but *hard for mark prices* (required `fetched_at_unix_ms` rejected `fetchedAtUnixMs`). If you see funding-rate events with all-null rate fields, this is why.
- **No replay buffer on either WS.** Refetch state on reconnect — `/positions` and `/orders` for `/ws` invalidation pings, full snapshot on `/ws/market` subscribe (server pushes a snapshot immediately on subscribe so you don't have to wait a tick).
- **App-level ping** every ~25s keeps the socket alive across intermediaries. Send `{"type":"ping"}`, get `{"type":"pong"}`.
- **Symbol convention differs across events.** `mark_price_update` and `funding_rate_update` use canonical symbols (`SOL`, `XAU`). `phoenix_depth_update` uses **Phoenix-raw** symbols (`SOL`, `GOLD`, …) matching what `/phoenix/depth` returns. Translate `XAU ↔ GOLD` if you fan out to a single client view.

### Error semantics

- **`/api/v1/status`** is the canonical health probe. Watch `db`, `indexer.status`, `orderBot.status`. `orderBot.unhealthy` with `rpc: connected` is operationally fine for core trading (per Hunter @ Imperial).
- **Rate limit**: 600 req/min sustained, burst 120. Keyed per-wallet when JWT present, else per-IP. 429 returns `{ error: "rate_limited", retry_after_seconds: N }` plus a `Retry-After` header. `/health`, `/ws`, Telegram webhook are exempt.
- **TLS routing on Railway can flap.** If Imperial's app is unhealthy or restarting, Railway's edge serves its default `*.up.railway.app` cert in place of the issued `api.imperial.space` cert. Strict TLS clients (Node `fetch`, rustls) fail before the HTTP layer. `openssl s_client -servername api.imperial.space -connect api.imperial.space:443` will print `CN=*.up.railway.app` when this happens — that's the smoking gun to point at Imperial / Railway, not your code.
- **The 401 path is overloaded.** As of this writing, any of `{bad nonce format, stale/replayed nonce, bad signature, session-store failure}` can surface as the same `401 "Failed to generate mobile session"`. To narrow down: send a deliberately malformed message — if you get 400 `"Invalid message format"`, your message construction is fine and the failure is server-internal.

### Naming conventions

- **"profile" and "subaccount" are the same thing.** The OpenAPI mixes both terms. The field name everywhere is `profileIndex`. Numbered 0..5, all isolated-margin.
- **The `/mobile` URL prefix is a misnomer.** It applies to all trading clients including server-side bots, not just mobile / Telegram. Imperial started as a mobile/Telegram bot service and the namespace stuck. There is no non-`/mobile/` order endpoint.
- **`/positions` vs `/trades`** — both return the same `PositionList` shape and the names are historical. `/positions` filters to currently-open lifecycles; `/trades` returns open + closed paginated. Use `/trades` for history pages, `/positions` for active dashboards.
- **"Underwriter" = "venue"** in casual speech. The wire types are numeric (0..3); strings (`jupiter` / `flash_trade` / `phoenix` / `gmtrade`) appear on read endpoints (`/funding-rates`, `/route`).

### Trading bot quickstart (from Imperial's docs)

The canonical sequence for opening + hedging a position:

1. **Auth** — `/mobile/connect` → `/mobile/exchange` → cache JWT
2. **Fund the profile** — `/deposit/build-tx` (sign + submit). Skips if profile already funded.
3. **Pick venues** — `/funding-rates` for a side-by-side view, or `/route?asset=SOL&side=long&notional=…` for a cost-optimized pick.
4. **Check funded USDC** — `/mobile/balances`. Under-funded profiles fail the margin check on submission.
5. **Open the legs** — `/mobile/orders` with `action=0`. Inspect `success` and `error` (not just HTTP status). Resting orders return `orderPda` you can cancel/update without indexer lag.
6. **Track state** — subscribe to both WS endpoints. `/ws` pings on position/order change, `/ws/market` pushes marks/funding/depth. No replay buffer, so refetch on reconnect.
7. **Close the legs** — `/mobile/orders` with `action=1`. `sizeUsd` = open size for a full close.
8. **Reclaim residue** — `POST /passthrough/users/{wallet}/profiles/{index}/sync` after closing non-USDC custody (long SOL/BTC/ETH on Jupiter or Flash leaves wrapped tokens on the profile). Idempotent. Pure-USDC venues (Phoenix shorts) skip this.

### Reference implementations in this repo

| Concern | File | Lines of code |
|---|---|---|
| JWT auth + REST client | `metric-frontend/src/lib/imperial/client.ts` | ~200 |
| Imperial DTOs (TS) | `metric-frontend/src/lib/imperial/types.ts` | full enum set + request/response shapes |
| Imperial DTOs (Rust) | `metric-backend/src/imperial/types.rs` | |
| Upstream WS client (Rust) | `metric-backend/src/imperial/ws.rs` | reconnect + ping + snake_case mapping |
| Pluggable signer abstraction | `metric-frontend/src/lib/wallet/{types,phantom-signer,privy-stub,useSigner}.ts` | |
| Live integration suite | `tests/imperial-live.mjs` | T1 auth + T2 deposit + T3 order place/cancel |
| Backend integration suite | `tests/e2e-imperial.mjs` | covers backend boundary + WS fan-out |
| Local Solana signing validation | `tests/signing-local.mjs` | no Imperial dependency |

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
