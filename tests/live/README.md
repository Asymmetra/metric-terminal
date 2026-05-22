# Live Imperial test suite

Real-network, **real-money** integration tests for native Imperial trading with
the funded test wallet (`.keys/test-wallet.json`, pubkey `HP29…`). These exercise
the exact flows the terminal UI uses — deposit, order-bot open/close, sweep,
withdraw — against mainnet Imperial + Solana.

Every scenario is **repeatable**: funds opened/deposited are closed/withdrawn back
to the wallet at the end, so the wallet returns to ~its starting balance (minus a
few cents of fees/spread).

## Running

From the repo root:

```bash
node tests/live/run.mjs --list                 # list scenarios + cost
node tests/live/run.mjs                         # safe only (reads, no money)
node tests/live/run.mjs --orderbot              # safe + order-bot (no wallet signature)
SOLANA_RPC=https://… node tests/live/run.mjs --all          # everything (spends fees)
SOLANA_RPC=https://… node tests/live/run.mjs roundtrip-market   # one scenario
```

`SOLANA_RPC` must be a mainnet endpoint that accepts `sendTransaction` (Helius /
QuickNode / Triton with a token; the public `solana-rpc.publicnode.com` works for
light use). Required for any `onchain` scenario.

### Env knobs

| var          | default | meaning                                            |
|--------------|---------|----------------------------------------------------|
| `SOLANA_RPC` | —       | RPC for wallet-signed txs (required for `onchain`) |
| `PROFILE`    | `0`     | isolated sub-account index (0..5)                  |
| `AMOUNT_USD` | varies  | deposit size for deposit/bootstrap scenarios       |
| `BUFFER_USD` | `0.3`   | fee cushion added to the deposit on opens          |
| `SOL_MARKET_MINT` | wrapped SOL | override the mint for collateral-adjust       |

## Scenario kinds

- **safe** — read-only (auth handshake + GETs). No chain writes, no money.
- **orderbot** — JWT-delegated order-bot writes (place/update/cancel resting
  orders). No wallet signature, operator-paid; needs the profile pre-funded.
- **onchain** — wallet-signed deposit/withdraw txs (needs `SOLANA_RPC`). Spends
  base fees + any trading fees/spread.

## Findings from live runs (mainnet, validated)

- **Phoenix is CLOB / limit-only via this path** — a Phoenix *market* order
  returns a generic "Failed to place order — please try again". But `/route` ranks
  purely by **cost** and is order-type-blind, so it *can and does* return Phoenix
  for SOL — which is what stranded a user's deposit. **Fix:** for market orders the
  UI (and `roundtrip-auto`) drop Phoenix from the candidates and **fall through**
  the remaining cost-ordered venues until one fills (`marketVenueCandidates` in
  `src/lib/trade-flow.ts`, mirrored by `marketVenues` here). GMTrade reliably
  accepts SOL market open+close; Flash sometimes rejects "route too large"
  (handled by fall-through); Jupiter had a collateral-unit mismatch. Phoenix-only
  synthetics (CHIP, LIT, MET, MON, SKR, VVV, WTIOIL) have no market-capable venue,
  so the UI blocks market orders there pre-deposit and suggests a limit order.
- **Deposits are exactly the entered collateral** (no fee buffer) — venue open fees
  are netted into the position, not taken from the profile's free balance.
- **Limit orders work on Phoenix** (they rest on the book), which is why
  `limit-cancel` / `limit-update-cancel` use Phoenix.
- **Account + ATA creation is folded into the first deposit** (operator-sponsored
  rent) — verified by `account-bootstrap`.
- **Collateral edits** (`/mobile/orders/collateral`) currently return a generic
  error on GMTrade SOL with both canonical and resolved index mints — treated as
  experimental (soft warning) pending confirmation of the correct per-venue
  addressing. `collateral-adjust` still validates open/close/withdraw around it.
- Free public RPCs blip; the harness retries transient 5xx/timeouts and confirms
  via HTTP `getSignatureStatuses` (not the WS `confirmTransaction`, which hangs on
  endpoints that don't serve WS). `api.mainnet-beta.solana.com` has been the most
  reliable for these runs.

## Adding a scenario

1. Create `scenarios/<id>.mjs` exporting `meta` + a default `async function(ctx)`:

   ```js
   export const meta = { id: "my-thing", kind: "onchain", cost: "~cents", summary: "…" };
   export default async function run(ctx) {
     const { r, ensureJwt, getRpc, placeOrder, buildOrder, PROFILE } = ctx;
     // …use ctx helpers; report with r.ok / r.bad / r.assert / r.info …
   }
   ```

2. Register it in `run.mjs` (`import * as myThing …` + add to `SCENARIOS`).

`ctx` (built in `harness.mjs` → `makeCtx`) gives you: the wallet + JWT
(`ensureJwt`), RPC (`getRpc`), `signSubmitConfirm`, balance/position reads
(`getBalances`, `profileFreeUsd`, `findOpenPosition`, `solMark`), composite
actions (`ensureFunded`, `withdrawAll`, `placeOrder`, `sweepProfile`,
`buildSignSubmit`), request builders (`buildOrder`, `buildClose`), scales/enums,
and the reporter `r`.
