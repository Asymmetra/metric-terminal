# AGENTS.md

Orientation for AI agents (and humans) working in this repository. This is the
canonical agent guide; `CLAUDE.md` defers to it. For the deep, war-story-level
Imperial integration notes, read [`README.md`](./README.md) — this file is the
map, the README is the territory.

## What this repo is

`metric-terminal` is a **proof-of-concept** perpetuals trading terminal built
**entirely on top of [Imperial](https://api.imperial.space/api/v1/openapi.json)** —
Asymmetra's passthrough router that brokers trades across Phoenix, Jupiter, Flash
Trade, Flash V2, GMTrade, plus Imperial's own Pairs and Touch products. It is a
worked example of how to integrate Imperial end-to-end: auth, reads, live data,
the one-signature deposit→open / close→withdraw flow, and several trading UIs.

- `metric-frontend/` — Next.js 16 / React 19 / TypeScript / Tailwind v4 / Zustand.
- `metric-backend/` — Rust / Axum. A thin, optional WS-fanout + candle-aggregation
  + `deposit/build-tx` proxy layer. The frontend works without it.

## Golden rules (do not violate)

1. **No simulated or fake data.** Every number comes from a real Imperial / Solana
   API call. Never stub market data, prices, or balances to make a UI "work."
2. **The backend never signs.** Every tx-building endpoint returns an *unsigned*
   (or Imperial-partially-signed) transaction; the client signs. The
   `SignerProvider` interface (`src/lib/wallet/`) is the swap point (Phantom in the
   PoC → Privy + paymaster in production).
3. **Imperial is upstream — call it, don't reimplement it.** The backend is a
   proxy + fan-out + derived-data layer. Do not re-implement Imperial endpoints;
   order placement goes **directly** from the browser to Imperial (JWT-delegated),
   bypassing the backend entirely.
4. **Verify before committing.** Frontend: `npx tsc --noEmit` and `npm test` (Vitest).
   Backend: `cargo clippy -- -D warnings` and `cargo test`. All testing is
   automated — no manual/human-in-the-loop steps required to prove correctness.
5. **Money paths are gated on a verified contract.** Before writing any order-
   placement code for a venue, confirm the field mapping against the live
   OpenAPI + on-chain reality. Never move real funds on an unverified contract.

## Where the important logic lives

| Concern | File |
|---|---|
| Imperial REST/JWT client + all reads | `metric-frontend/src/lib/imperial/client.ts` |
| Imperial DTOs, enums, request/response shapes | `metric-frontend/src/lib/imperial/types.ts` |
| WS adapters (`/ws`, `/ws/market`) | `metric-frontend/src/lib/imperial/ws.ts` |
| Order-request builder + **per-venue price scales** | `metric-frontend/src/lib/order-builder.ts` |
| One-signature deposit→open / close→withdraw | `metric-frontend/src/lib/trade-flow.ts` |
| 60-second "degen" game flow | `metric-frontend/src/app/degen/game-flow.ts` |
| Imperial Touch (one-touch binaries) flow | `metric-frontend/src/lib/touch-flow.ts`, `touch-order.ts` |
| Shared market-data feed → Zustand stores | `metric-frontend/src/lib/market-data.ts` |
| Pluggable signer (Phantom ↔ Privy) | `metric-frontend/src/lib/wallet/` |
| Backend Imperial client + WS + candles | `metric-backend/src/imperial/` |

## Imperial concepts an agent must internalize

- **Auth:** `POST /mobile/connect` → `POST /mobile/exchange` → 30-day JWT. The
  connect nonce must be a **unix timestamp** (±5 min), and the signature is **raw
  ed25519 over UTF-8 bytes** (not the Solana off-chain-message envelope). The JWT
  is a delegation — treat it like an API key. Order placement is JWT-only; there is
  no API-key alternative.
- **`HTTP 200 ≠ success.`** `/mobile/orders` returns 200 even on rejection. Always
  check the `success` boolean and read `error`.
- **Price scales:** `triggerPrice` and all `extraData` prices are **oracle scale
  (1e9)** on every venue. `sizeUsd` / `collateralAmount` are **6-decimal fixed
  point** (1e6 = $1). `marketPrice` (market-order slippage reference) is
  **per-underwriter**: Phoenix/Jupiter = 1e6 micro-USD, Flash = `10^-priceExponent`,
  GMTrade = 1e9, Flash V2 and Imperial Pairs = **ignored, send 0** (they execute on
  the MagicBlock ephemeral rollup). This is centralized in `order-builder.ts`.
- **Underwriter enum:** 0 Jupiter · 1 Flash Trade · 2 Phoenix · 3 GMTrade ·
  4 Flash V2 · 5 Imperial Pairs · 6 Imperial Touch.
- **Profiles 0..5** are isolated-margin sub-accounts that never share balances;
  created lazily on first deposit/order.
- **WS payloads are `snake_case`** even though REST/OpenAPI is `camelCase`. No
  replay buffer — refetch on reconnect.

## Running & verifying

```bash
# Frontend (works standalone)
cd metric-frontend && npm install && npm run dev      # http://localhost:3000
npx tsc --noEmit && npm test

# Backend (optional)
cd metric-backend && cargo run                        # http://localhost:3001
cargo clippy -- -D warnings && cargo test

# Live Imperial integration (real money — bring your own funded wallet)
node tests/live/run.mjs --list                        # see tests/live/README.md
```

## What is intentionally NOT in this repo

- **Production auth.** The signer is Phantom via `wallet-adapter`. Privy + paymaster
  is stubbed behind `SignerProvider` (`src/lib/wallet/privy-stub.ts`) but not wired.
- **A custodial backend / server-side signing.** By design — see rule 2.
- **A database.** State of record is Imperial + on-chain; UI state is Zustand +
  `localStorage` (JWT cache, session price buffer). No Supabase/Postgres.
- **Every Imperial venue at production hardening.** Touch trades the 24h tenor
  (short tenors exist but aren't quoted yet); Pairs has a read-only `/api/pairs`
  endpoint and trading is gated pending a live contract confirmation.
