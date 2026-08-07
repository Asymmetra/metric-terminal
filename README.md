# Metric Terminal

A high-performance perpetuals trading terminal targeting [Imperial](https://api.imperial.space/api/v1/docs) on Solana — a passthrough router that brokers trades across Phoenix, Jupiter, Flash Trade, and GMTrade with isolated-margin profiles (0..5 per wallet). Built with a Rust/Axum backend and Next.js frontend.

> This is a fork of Ember Terminal (originally a Phoenix-Rise SDK PoC). Every Phoenix-Rise-shaped code path has been ripped out and replaced with calls against Imperial's HTTP/WS API. Imperial integrates Phoenix as one of its four underwriters; you'll see Phoenix referenced where Imperial's own surface exposes it (e.g. `/phoenix/depth`, `/phoenix/register`, `underwriter: 2`), and nowhere else.

## What's included

**Trading UIs** (`metric-frontend/src/app/`, all live against Imperial — no fake data):

| Route | What it is |
|---|---|
| `/terminal` | The full trading view — connect, authenticate, live marks + order book, deposit → open → close → withdraw. |
| `/degen` | A 60-second high-leverage "degen" game — one-tap open, auto-close, live-line chart. |
| `/touch` | Imperial Touch — one-touch binary options (barrier grid, live payout/premium, buy + sell-back). |
| `/status`, `/debug` | Health + diagnostics for the backend, Imperial, and the WS feeds. |
| `/` | Landing page. |

**Public JSON endpoints** (Next.js API routes — no auth, CORS-open, cached):

| Route | What it returns |
|---|---|
| `/api/markets[?venue=…]` | Aggregated market data across all Imperial venues (optional venue filter). |
| `/api/pairs` | Imperial Pairs markets (SOLBTC geometric + single-feed) with funding/borrow rates. |

**Reusable Imperial integration** lives in `metric-frontend/src/lib/` — the JWT
client, the per-venue order-request builder, the one-signature trade-flow
orchestration, the Touch flow, and the pluggable signer. See the
[reference table](#reference-implementations-in-this-repo) below.

## What's NOT included

- **Production auth.** Signing is Phantom via `wallet-adapter`; Privy + paymaster is
  stubbed behind `SignerProvider` (`src/lib/wallet/privy-stub.ts`) but not wired.
- **A custodial backend / server-side signing** — by design; the backend never signs.
- **A database.** Imperial + on-chain is the state of record; UI state is Zustand +
  `localStorage` (JWT cache, session price buffer). No Supabase/Postgres.
- **Full venue hardening.** Touch trades the 24h tenor only (shorter tenors exist in
  the API but aren't quoted yet); Imperial Pairs is exposed read-only (`/api/pairs`)
  and trading is gated pending a live order-contract confirmation.

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

Source: `mobile.rs:186-190` (API: accepts any string) vs `http.rs:564-588` (order bot: requires u64-parseable, ±5min). Surfaced with the Imperial team — not documented anywhere user-facing.

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
- **`marketPrice` scale is venue-specific — the subtle one that cost us the most.** For a market order, `marketPrice` is the slippage reference forwarded to the on-chain instruction. **Phoenix wants it in 6-decimal USD (`1e6`)** — the same scale as `sizeUsd`/`collateralAmount` — while **Jupiter / Flash / GMTrade want oracle scale (`1e9`)**, the documented default. Send a Phoenix market order with `1e9` and it's "1000× off": the keeper rejects with a generic `success:false, error:"Failed to place order — please try again"` and *no hint* that it's a scale problem. (Phoenix *limit* `triggerPrice` still uses `1e9` — only the market-order `marketPrice` differs.) We resolve this per-underwriter in `src/lib/order-builder.ts` → `toMarketPrice(dollars, venue)`. Confirmed live + by the Imperial team.
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

- **`/api/v1/status`** is the canonical health probe. Watch `db`, `indexer.status`, `orderBot.status`. `orderBot.unhealthy` with `rpc: connected` is operationally fine for core trading (per the Imperial team).
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

### Routing & the one-signature deposit→open / close→withdraw flow

This terminal lets a user open with a single wallet signature and close+withdraw with
a single wallet signature. The orchestration lives in `src/lib/trade-flow.ts`
(`openWithDeposit`, `closeAndWithdraw`, `marketVenueCandidates`) — useful reference if
you're building the same UX.

- **`/route` is cost-ranked and order-type-blind.** It ranks venues purely by expected
  round-trip cost (which shifts with funding/fees), so it can return Phoenix for a
  *market* order. Honor its pick — but for market orders be ready to **fall through** to
  the next candidate if a venue rejects (Flash sometimes returns "route too large";
  Jupiter has a different collateral unit). Don't hardcode a venue — the router favors
  Phoenix at low leverage by design, and that's usually the cheapest fill. Once you send
  the correct venue-specific `marketPrice` scale (above), Phoenix market orders fill.
- **Account creation folds into the first deposit.** `/deposit/build-tx` (`mode:"deposit"`)
  creates the user-account PDA + the profile's USDC ATA when missing (operator-sponsored
  rent) before transferring USDC. So a brand-new user's first "deposit & trade" bootstraps
  the whole account in that one signature — no separate init step.
- **Open = one signature; the order itself needs none.** Deposit the collateral (the wallet
  signs once), wait for it to land in the profile, then `POST /mobile/orders` — the order
  bot signs/submits via the JWT delegation, so there's no second wallet prompt.
- **Close+withdraw is two on-chain steps and is NOT atomic.** The close runs on the order
  bot (no signature); the withdraw is the only wallet tx. If the user rejects the withdraw
  popup, the position is still closed and the funds sit in the profile (recoverable —
  withdraw later). Make this legible in your UI; it can't be made all-or-nothing because
  the two halves have different signers.

### Reference implementations in this repo

| Concern | File | Notes |
|---|---|---|
| JWT auth + REST client | `metric-frontend/src/lib/imperial/client.ts` | connect/exchange, all `/mobile/*` + reads + `/deposit/build-tx` + sweep/register |
| Order-request builder + scales | `metric-frontend/src/lib/order-builder.ts` | enum mapping, `toUsdFixed`/`toOracle`, **`toMarketPrice` (per-venue scale)** |
| Deposit→open / close→withdraw orchestration | `metric-frontend/src/lib/trade-flow.ts` | `openWithDeposit`, `closeAndWithdraw`, `marketVenueCandidates` (honor `/route` + fall-through) |
| Imperial DTOs (TS) | `metric-frontend/src/lib/imperial/types.ts` | full enum set + request/response shapes |
| JWT cache (30-day, localStorage) | `metric-frontend/src/lib/imperial/jwt.ts` | per-wallet, expiry-guarded |
| Pluggable signer abstraction | `metric-frontend/src/lib/wallet/{types,phantom-signer,privy-stub,useSigner}.ts` | swap Phantom ↔ Privy+paymaster |
| Imperial DTOs / WS client (Rust) | `metric-backend/src/imperial/{types,ws}.rs` | reconnect + ping + snake_case mapping |
| **Live integration suite (modular)** | `tests/live/` (`run.mjs` + `scenarios/`) | auth/reads, deposit/withdraw, order place/update/cancel, full market round-trip, Phoenix market, partial close — all against real mainnet |
| Backend integration suite | `tests/e2e-imperial.mjs` | backend boundary + WS fan-out |
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
│   │   ├── terminal/        the working trading view (Terminal.tsx)
│   │   ├── status/          health-status view
│   │   └── layout.tsx       root layout with WalletProvider
│   ├── components/
│   │   ├── terminal/        OrderEntry, Orderbook, VenueQuotes, MarketDepthPanel,
│   │   │                    Chart, PriceChart, LiveLineChart, Positions,
│   │   │                    MarketHeader, WalletMenu, HealthIndicator
│   │   └── health/HealthPanel.tsx
│   ├── lib/
│   │   ├── wallet/          SignerProvider + Phantom + Privy stub + useSigner
│   │   ├── imperial/        ImperialClient + types + jwt cache + config + ws adapters
│   │   ├── order-builder.ts request builder + scales (toMarketPrice per venue)
│   │   ├── trade-flow.ts    openWithDeposit / closeAndWithdraw / marketVenueCandidates
│   │   ├── price-history.ts session price buffer for the live line
│   │   ├── phoenix-*.ts     direct Phoenix WS (depth/mid) + candle REST
│   │   └── format.ts
│   ├── stores/             zustand: market, stats, orderbook, trader, toast, health
│   └── providers/WalletProvider.tsx

tests/
├── live/                    modular live Imperial suite (real mainnet) — see tests/live/README.md
│   ├── run.mjs              CLI runner: `node tests/live/run.mjs --list | --orderbot | --all | <scenario>`
│   ├── harness.mjs          shared: wallet, JWT, RPC, sign/confirm, builders, reporter
│   └── scenarios/           auth-reads, deposit-withdraw, account-bootstrap, limit-cancel,
│                            limit-update-cancel, roundtrip-auto, phoenix-market,
│                            roundtrip-market, partial-close, collateral-adjust
├── e2e-imperial.mjs         backend integration suite (runs against local metric-backend)
├── imperial-live.mjs        legacy single-file live suite (superseded by tests/live/)
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
# Frontend (port 3000) — works standalone; calls Imperial + Phoenix directly
cd metric-frontend
npm install
cp .env.example .env.local      # optional — sane public defaults work out of the box
npm run dev

# Backend (port 3001) — OPTIONAL: WS fan-out, candle aggregation, health probe
cd metric-backend
cargo run
```

Open <http://localhost:3000> → `/terminal`. The terminal is fully functional without
the backend (the health panel just shows it as down). Connect Phantom, place a trade —
deposits/withdraws sign in your wallet; orders execute via Imperial's delegated bot.

### Tests

```bash
# Backend
cd metric-backend
cargo test
cargo clippy -- -D warnings

# Frontend (unit + tsc)
cd metric-frontend
npx tsc --noEmit
npm test                                   # Vitest (order-builder, trade-flow, imperial, wallet, …)

# Backend integration (boot metric-backend, then)
node tests/e2e-imperial.mjs                # checks against http://127.0.0.1:3457

# Solana signing path (no Imperial needed)
node tests/signing-local.mjs

# Live against api.imperial.space — modular suite, funded test wallet (.keys/test-wallet.json)
node tests/live/run.mjs --list             # list scenarios + their cost
node tests/live/run.mjs                     # "safe" tier only — reads, no money
node tests/live/run.mjs --orderbot          # + order-bot writes (place/update/cancel; no wallet signature)
SOLANA_RPC=https://… node tests/live/run.mjs --all            # everything (real mainnet fees)
SOLANA_RPC=https://… node tests/live/run.mjs roundtrip-auto   # one scenario (the UI's deposit→open→close→withdraw)
```

`--all` and the `onchain` scenarios spend real fees and need a mainnet `SOLANA_RPC`
that accepts `sendTransaction` (Helius / QuickNode / Triton; the public
`solana-rpc.publicnode.com` works for light use). See `tests/live/README.md` for the
full scenario list, env knobs (`PROFILE`, `AMOUNT_USD`, `BUFFER_USD`), and how to add a
scenario.

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
| `NEXT_PUBLIC_IMPERIAL_API_URL` | https://api.imperial.space | frontend → Imperial REST direct (JWT-authed paths) |
| `NEXT_PUBLIC_IMPERIAL_WS_URL` | wss://api.imperial.space | frontend → Imperial WS direct |
| `NEXT_PUBLIC_PHOENIX_API_URL` | https://perp-api.phoenix.trade | direct Phoenix REST (candles, depth) |
| `NEXT_PUBLIC_PHOENIX_WS_URL` | wss://perp-api.phoenix.trade/ws | direct Phoenix WS (live mid + order book) |
| `NEXT_PUBLIC_SOLANA_RPC` | (public fallbacks) | mainnet RPC for deposit/withdraw signing — Helius/QuickNode/Triton recommended |
| `NEXT_PUBLIC_SIGNER` | phantom | `phantom` or `privy-stub` |

## Deployment

### Frontend → Vercel

The Next.js app lives at `metric-frontend/`, **not at the repo root**. Vercel must be told this or it will produce a "Ready" deployment that 404s on every path.

**One-time project setup** (Vercel Dashboard → your project → Settings):

1. **Build & Development Settings → Root Directory** → set to `metric-frontend`
2. **Build & Development Settings → Framework Preset** → `Next.js` (usually auto-detected once Root Directory is right)
3. **Environment Variables** — add all four for Production *and* Preview:

   | Name | Value | Purpose |
   |---|---|---|
   | `NEXT_PUBLIC_IMPERIAL_API_URL` | `https://api.imperial.space` | Imperial REST direct from browser |
   | `NEXT_PUBLIC_IMPERIAL_WS_URL`  | `wss://api.imperial.space`   | Imperial WS direct from browser |
   | `NEXT_PUBLIC_API_URL`          | (your metric-backend URL, e.g. `https://metric-backend.onrender.com`) | optional — HealthPanel polls this; if absent the panel just shows it as down and the page still works |
   | `NEXT_PUBLIC_WS_URL`           | (your metric-backend WS, e.g. `wss://metric-backend.onrender.com/ws`) | optional — same |
   | `NEXT_PUBLIC_SOLANA_RPC`       | a Helius / QuickNode / Triton URL — see note below | optional override; defaults to public RPCs (mainnet → publicnode) if unset. Required if you want production-grade rate limits |
   | `NEXT_PUBLIC_SIGNER`           | `phantom` (default) or `privy-stub` | active signer impl |

4. **Redeploy** the latest commit on `main`.

After this:
- `metric-terminal.vercel.app/` — landing
- `metric-terminal.vercel.app/terminal` (or `metric.asymmetra.xyz/terminal`) — connect Phantom, authenticate with Imperial, deposit, place orders
- `metric-terminal.vercel.app/status` — live health of metric-backend + Imperial + WS feed

**Solana RPC URL format**:

- **Helius**: `https://mainnet.helius-rpc.com/?api-key=<KEY>`
- **QuickNode**: `https://your-endpoint.solana-mainnet.quiknode.pro/<TOKEN>/`
- **Triton RPCPool**: `https://<endpoint-name>.mainnet.rpcpool.com/<TOKEN>` — the host and the token are listed separately in the Triton dashboard; concatenate them with `/` for the URL.

The frontend has a built-in fallback chain (`src/lib/solana-rpc.ts`):

1. `NEXT_PUBLIC_SOLANA_RPC` (env var) — your primary endpoint.
2. `https://api.mainnet.solana.com` — Solana Labs public, rate-limited.
3. `https://solana-rpc.publicnode.com` — publicnode community public.

`selectBestRpc()` runs at WalletProvider mount, races the candidates, and picks the first to answer `getSlot`. If the env-var primary is degraded the page swaps to a public fallback automatically; if every URL fails the user still gets a Connection pointed at the primary so error messages stay diagnostic.

**CSP allowlist** (`metric-frontend/vercel.json`) already lists `api.imperial.space`, `wss://api.imperial.space`, mainnet, `solana-rpc.publicnode.com`, and the common RPC providers (Helius, QuickNode, RPCPool — `*.mainnet.rpcpool.com`). If you use a different RPC, add it to the `connect-src` directive.

### Backend → Render (optional)

The metric-backend serves the WS fan-out, candle aggregation, and the `/deposit/build-tx` proxy. The frontend works fully without it — the `/terminal` page subscribes to Phoenix's WS directly and calls Imperial REST directly — but the health-status panel shows metric-backend as down until it's deployed.

To deploy:

1. `render.yaml` is already wired (`metric-backend` service, Docker, port 10000).
2. Push to GitHub triggers a Render rebuild from `Dockerfile`.
3. Set environment variables in the Render dashboard:
   - `IMPERIAL_API_URL=https://api.imperial.space`
   - `IMPERIAL_WS_URL=wss://api.imperial.space`
   - `CORS_ORIGIN=https://metric-terminal.vercel.app` (your Vercel domain — comma-separated for multiple)
   - `RUST_LOG=metric_backend=info`
4. Once deployed, point the Vercel project's `NEXT_PUBLIC_API_URL` + `NEXT_PUBLIC_WS_URL` at the Render URL and redeploy.

### Production checklist

- [ ] Vercel Root Directory = `metric-frontend`
- [ ] `NEXT_PUBLIC_IMPERIAL_API_URL` + `NEXT_PUBLIC_IMPERIAL_WS_URL` set on Vercel
- [ ] `NEXT_PUBLIC_SOLANA_RPC` set on Vercel (required for deposits — Helius free tier is fine for the demo)
- [ ] Phantom installed in the browser used to test
- [ ] Test wallet (or your own) has ≥ 0.01 SOL for gas + ≥ $10 USDC for the Imperial minimum collateral
- [ ] Optional: metric-backend deployed to Render and pointed at via `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` so HealthPanel shows green

### What the user sees on `/terminal`

1. **Connect wallet** → custom wallet menu (Select Wallet → Phantom prompt). On return,
   a cached 30-day JWT is re-hydrated from localStorage, so no re-authentication.
2. **First trade authenticates** → Phantom prompts to sign
   `imperial:mobile-connect:{wallet}:{unix-ms-nonce}` once; the JWT is cached per wallet.
3. **Deposit & Long/Short** (one signature) → if the profile is short on collateral, the
   app deposits exactly what's needed (creating the account on a first trade), then the
   order bot opens via Auto's routed venue — no second signature.
4. **Close & Withdraw** → the order bot closes (no signature), then one signature withdraws
   the freed balance back to the wallet.
5. **Order book / Venues** tabs, candle + live-line charts, per-profile balances, and a
   header health dot round out the view.

If you see 404s or blank pages, 90% of the time it's the Vercel Root Directory (#1 above)
or the CSP missing `api.imperial.space` (overridden somewhere, or a custom security header
takes precedence).

## License

MIT
