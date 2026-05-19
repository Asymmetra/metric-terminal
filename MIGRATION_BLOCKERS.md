# Phoenix → Imperial migration — remaining work

Status as of the current commit. Phases A → D landed; Phase E (e2e verification)
is partially complete. This doc tracks every surface that's *not* fully
migrated to Imperial and the rationale.

## Working today (verified)

| Surface | How verified |
|---|---|
| Backend boots, connects upstream WS | `cargo run` + log inspection |
| `GET /api/markets` | 186 rows across phoenix/flash/gmtrade |
| `GET /api/orderbook/:symbol` | Phoenix-only depth returned for SOL |
| `GET /api/candles/:symbol` | Aggregated from mark-price WS, bars accumulating |
| `GET /api/trader/:wallet`, `…/trades` | Proxies Imperial `/positions`, `/trades` |
| `GET /health{,/relay,/memory}` | Returns `ok` with 190 active broadcast channels |
| `/ws` fan-out from Imperial `/ws/market` | Raw WS client smoke: 16 mark + 15 candle events in 8s |
| `POST /api/tx/deposit`, `/withdraw` | Proxies `/deposit/build-tx`; returns base64 partial tx |
| `metric-frontend` `tsc --noEmit` | Clean |
| `metric-frontend` Vitest suite | 14 / 14 pass |
| Imperial connect/exchange flow | Unit-tested with mocked fetch |
| `/imperial` page | New demo route renders signer + JWT + balances + positions + live marks + deposit |
| Rebrand + theme swap | Visually verified on landing page |

## Pending — frontend OrderEntry rewrite

**File**: `metric-frontend/src/components/terminal/OrderEntry.tsx` (and its
hook `src/hooks/useTransactionBuilder.ts`).

Both call `api.buildMarketOrder` / `buildLimitOrder` / `buildIsolatedMarketOrder`
/ `buildIsolatedLimitOrder` / `buildCancelOrders` / `buildTransferCollateral` /
`buildRegisterSubaccount` / `buildMultiLimitOrders` / `buildCancelStopLoss`.
The backend now returns **410 Gone** for all of these. The legacy `/terminal`
route still compiles and renders but submitting an order will fail at
HTTP 410.

**Why deferred**: Imperial's `/mobile/orders*` is JWT-delegated per-wallet
(see [MIGRATION_BLOCKERS.md#imperial-signing-model](#imperial-signing-model)).
The rewrite needs to:
1. Call `imperial.placeOrder(req, jwt)` directly from the frontend (the
   `ImperialClient` already exposes it).
2. Replace the Ember "Cross vs Isolated" UI with a `profileIndex` (0..5)
   selector — Imperial is isolated-only.
3. Add a `venue` picker (Phoenix / Jupiter / Flash / GMTrade) seeded by
   `/api/v1/route?...` if we want auto-routing.
4. Collapse the dual market/limit endpoints into one `orderType` (0/1/…).
5. Drop the bracket-leg endpoint in favor of `/mobile/orders/batch`.

**Estimated effort**: 1–2 days for a faithful rewrite that hits feature
parity with the Ember OrderEntry. The new shape can copy-paste cleanly
to Asymmetra's production app.

**Workaround until rewritten**: use the `/imperial` demo page for end-to-end
verification.

## Pending — frontend pages that touch legacy backend routes

| Page / Component | Legacy call site | Status |
|---|---|---|
| `app/accounts/page.tsx` | `api.getTraderSubaccounts` (no longer served) | Stale data; pending rework as "Profiles 0..5" backed by Imperial `/mobile/balances` |
| `app/leaderboard/page.tsx` | Backend `/api/leaderboard` route was deleted | Page will show empty / 404 |
| `app/analytics/page.tsx` | Mix of `api.getTraderPnl` (deleted) + funding history (deleted) | Charts will be empty |
| `app/profile/page.tsx` | `api.getTrader` (still proxies `/positions`) | Partial — basic state works, but funding/PnL series will 404 |
| `components/terminal/Positions.tsx` | Consumes the trader store hydrated by `useTraderSync` which calls `api.getTrader` (proxies Imperial). Lifecycle response shape differs from the Ember shape it expects | Render path won't crash, but field mapping is stale (no `account.size`, etc.) |
| `components/terminal/TradeHistory.tsx` | `api.getRecentTrades` (deleted — Imperial has no public trade-print stream) | Empty list |
| `components/terminal/DepositWithdraw.tsx` | `api.buildDeposit` / `api.buildWithdraw` | **Works** — these are the only `/api/tx/*` routes still alive |

## Pending — observability data feeds

`src/hooks/useObservability.ts` polls Phoenix's perp-api directly for some
sources and the metric-backend for others. The `phoenix-ws-*` direct-polls
still resolve (Phoenix's public WS is still live), but their place in the
stats table will need rewording once the user adopts the Imperial-first
data model. No code action needed — annotations in `/stats` page will be
edited in the OrderEntry rewrite pass.

## Pending — production deployment renames

| Resource | Current | Target |
|---|---|---|
| Render service | `ember-backend-q4nf` | `metric-backend` |
| Vercel project | `ember-terminal-gamma` | `metric-terminal` |
| Domain references in CSP | `vercel.json` allows `ember-backend-q4nf.onrender.com` and `perp-api.phoenix.trade` | Add `api.imperial.space` and switch the backend host once renamed |

These require the user to act in the Render / Vercel UIs; left as
documented but unblocking for the local PoC.

## Architectural notes

### Imperial signing model

> *Trading endpoints are JWT-gated. The JWT is a Solana-signature-anchored
> delegation: holding it is equivalent to letting the operator place orders
> from the associated wallet's profiles.*

Practical consequence: **the metric-backend never holds a per-wallet JWT,
and order placement skips the backend entirely**. The frontend
`ImperialClient` runs the connect/exchange handshake against
`api.imperial.space` and stores the JWT in `localStorage` keyed by wallet.
This pattern maps cleanly to Privy + paymaster in production:
- Phantom → `signMessage` → JWT (now)
- Privy → `signMessage` via the embedded key → JWT (later, no code-shape
  change at call sites)

### Backend's reduced surface

The metric-backend is now ~1.4k lines (down from ~6.5k pre-swap). It is
deliberately small:
- WS fan-out hub (one upstream Imperial WS connection serves N browsers)
- Candle aggregation (Imperial has no candles endpoint)
- Market-list normalization across venues
- Deposit/withdraw build-tx pass-through (keeps the unsigned-tx contract
  uniform for the paymaster wrap)
- Health/observability endpoints

Everything else lives at `api.imperial.space` and is called directly from
the browser via `metric-frontend/src/lib/imperial/client.ts`.

### Wire-format quirk

Imperial's REST responses use camelCase keys (per OpenAPI). Imperial's
WebSocket `/ws/market` events use **snake_case** keys. The metric-backend's
`MarketEvent` enum models the wire format directly and rewrites to
camelCase when forwarding to browser /ws clients (see
`metric-backend/src/imperial/ws.rs` and `ws/relay.rs`).

## Run book

```bash
# Backend
cd metric-backend
cargo run                    # http://0.0.0.0:3001, /ws fan-out auto-starts

# Backend tests
cargo test
cargo clippy -- -D warnings

# Frontend
cd metric-frontend
npm install
npm run dev                  # http://localhost:3000
npm test                     # Vitest suite (14 tests)
npx tsc --noEmit             # type-check

# Manual e2e
open http://localhost:3000          # landing
open http://localhost:3000/imperial # full demo: connect → JWT → live data → deposit
```

Environment variables:
- Backend: `IMPERIAL_API_URL=https://api.imperial.space`,
  `IMPERIAL_WS_URL=wss://api.imperial.space`, `CORS_ORIGIN=http://localhost:3000`
- Frontend: `NEXT_PUBLIC_API_URL=http://localhost:3001`,
  `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws`,
  optionally `NEXT_PUBLIC_IMPERIAL_API_URL` if pointing at a non-prod instance.
