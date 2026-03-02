# Phoenix SDK — Developer Experience Report Card

**Project:** Ember Terminal — perpetuals trading terminal on Solana
**Stack:** Rust/Axum backend + Next.js/TypeScript frontend
**Timeline:** Weekend hackathon (3 days)
**Team:** 5 AI agents (PM, backend, frontend, design, QA)
**Date:** March 2026

---

## Overall Grade: B+

The Phoenix SDK is **functionally complete and architecturally sound**. We built a production trading terminal with live orderbook, real-time trades, market/limit orders, bracket orders (TP/SL), isolated margin, deposit/withdraw, and WebSocket streaming — all in a weekend. That speaks volumes about the SDK's capability. The friction we hit was almost entirely around **documentation gaps, naming inconsistencies, and a few private APIs we needed to access**.

---

## What Was Great

### 1. Transaction Builder Pattern — A+

The `PhoenixTxBuilder` is the best part of the SDK. Building complex multi-instruction transactions is clean and intuitive:

```rust
let builder = PhoenixTxBuilder::new(&metadata, &authority, symbol)?;
let instructions = builder.build_market_order(trader_pda, side, num_lots, None)?;
```

One call gives you all the instructions you need — register, sync, place order, bracket legs — without understanding the on-chain program's account layout. This saved us days.

### 2. WebSocket Client — A

Auto-reconnect built in. Subscription handle pattern is elegant — keep the handle alive, data flows; drop it, unsubscribe. We ran 5 concurrent market subscriptions + per-trader state subscriptions with zero manual reconnection logic:

```rust
let (mut rx, _keep_alive) = ws_client.subscribe_to_orderbook("SOL".to_string())?;
```

The `_keep_alive` pattern is a bit implicit (you need to know dropping unsubscribes), but once understood, it's clean.

### 3. HTTP Client — A-

Paginated responses with `data`, `has_more`, `next_cursor` work exactly as expected. Rate limit retry config is thoughtful:

```rust
PhoenixHttpClient::new_with_config(
    RateLimitRetryConfig::builder()
        .max_retries(3)
        .initial_backoff_ms(500)
        .build()
)
```

Order history, trade history, funding history, PnL time series, collateral history — all worked first try.

### 4. Market Metadata & Calculator — A

`PhoenixMetadata` gives instant access to market configs, and `get_market_calculator()` handles the gnarly price-to-ticks conversion that would otherwise require understanding tick sizes, lot sizes, and on-chain precision:

```rust
let calc = metadata.get_market_calculator(symbol)?;
let ticks = calc.price_to_ticks(150.50)?.as_inner();
```

### 5. Isolated Margin Support — B+

Despite the docs saying it's unsupported (more on this below), `build_isolated_market_order_tx()` and `build_isolated_limit_order_tx()` work well. The SDK automatically handles subaccount selection, registration, and collateral transfer. The async HTTP-based approach is slower than cross-margin but functionally correct.

### 6. Environment-Based Initialization — A

`PhoenixHttpClient::new_from_env()` and `PhoenixWSClient::new_from_env()` let us go from zero to connected in 2 lines. No config structs to wrestle with for the default case.

---

## What Needs Improvement

### 1. `build_bracket_leg_orders` Is Private — Critical

**Impact:** We had to reimplement 103 lines of bracket order logic in our backend.

The SDK's bracket leg builder (for TP/SL stop-loss orders on limit orders) is a private function. We needed it for limit orders with TP/SL, so we reverse-engineered the logic from `tx_builder.rs` and duplicated it:

```rust
// trade.rs — our 103-line reimplementation of private SDK logic
fn build_bracket_leg_orders(
    metadata: &PhoenixMetadata,
    authority: &Pubkey,
    symbol: &str,
    side: Side,
    tp_price: Option<f64>,
    sl_price: Option<f64>,
    trader_pda: Pubkey,
) -> Result<Vec<Instruction>, AppError> { ... }
```

This required deep knowledge of Phoenix account structure (`perp_asset_map`, `global_trader_index`, `active_trader_buffer` from `metadata.keys()`) and `phoenix_ix::create_place_stop_loss_ix()` internals. The private function we reimplemented lives in the SDK at `sdk/src/tx_builder.rs` — it's called internally by `build_market_order()` when bracket params are provided, but there's no equivalent path for limit orders.

**Recommendation:** Make `build_bracket_leg_orders` public, or better yet, add TP/SL params directly to `build_limit_order()` the same way `build_market_order()` accepts them.

### 2. Numeric Format Inconsistency — High Impact

The same conceptual field (e.g., a trader's collateral) arrives in different formats depending on whether it comes from the REST API or the WebSocket stream. Three distinct representations exist in the SDK:

**Format 1 — Decimal object** (REST HTTP responses, defined in `types/src/core.rs:7-14`):
```json
{ "value": 42500000, "decimals": 6, "ui": "42.5" }
```
Used by ~30 fields in `TraderView` (`types/src/trader_http.rs:594-612`): `effective_collateral`, `portfolio_value`, `initial_margin`, `unrealized_pnl`, and all position fields like `position_size`, `entry_price`, `liquidation_price` (`trader_http.rs:546-563`).

**Format 2 — Plain strings** (WebSocket trader state deltas, defined in `types/src/trader.rs:84-124`):
```json
{ "collateral": "23673164", "entry_price_usd": "14250000", "base_position_lots": "500" }
```
Used by all WS trader margin updates: `collateral` (`:84`), `base_position_lots` (`:119`), `entry_price_ticks` (`:120`), `entry_price_usd` (`:121`), `price_ticks` (`:200`), `order_sequence_number` (`:195`). These are raw integer strings (not human-readable) — no decimal point, no `ui` field.

**Format 3 — Plain f64 numbers** (WS market streams):
```json
{ "mark_price": 142.53, "funding_rate": 0.0001, "open_interest": 50000.0 }
```
Used by stats/market subscriptions: `mark_price`, `oracle_price`, `mid_price`, `funding_rate`, `open_interest`, `day_volume_usd`.

**The problem in practice:** A trader's `initial_margin` is a `Decimal` object from REST but a raw string from WS. A position's `entry_price` is `Decimal` from REST, string from WS, but `mark_price` is an f64 from a different subscription entirely. We wrote a defensive parser that handles all three:

```typescript
// Called 15+ times across traderStore.ts for every field extraction
function sdkNum(val: any): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val) || 0;
  if (typeof val === "object" && val.ui != null) return parseFloat(val.ui) || 0;
  return 0;
}
```

The WS format mismatch was severe enough that our frontend uses WS trader updates only as *triggers* to re-fetch the full trader state via REST — we don't parse the WS delta payload at all because the format is too different from what the rest of the codebase expects.

**Recommendation:** Unify around the `Decimal` object for all numeric fields across both REST and WS. It's the most informative format (provides raw value, precision, and human-readable string). At minimum, document the format differences per-endpoint so integrators know what to expect.

### 3. CamelCase vs Snake_Case Inconsistency — High Impact

Position fields alternate between naming conventions depending on whether data comes from the REST API or WS stream. The REST types in `trader_http.rs` use `snake_case` Serde renames (e.g., `position_size`, `entry_price`, `liquidation_price`), but the SDK's Rust struct fields and some WS payloads use `camelCase` (e.g., `positionSize`, `entryPrice`, `liquidationPrice`). We end up with double-fallback chains on the frontend for every field:

```typescript
// traderStore.ts — every position field needs this pattern
sdkPos.liquidationPrice ?? sdkPos.liquidation_price
sdkPos.marginMode || sdkPos.margin_mode
sdkPos.allocatedCollateral || sdkPos.allocated_collateral
sdkPos.tpPrice ?? sdkPos.tp_price
```

Order fields have the same issue: `orderSequenceNumber` vs `order_sequence_number` (`trader.rs:195` uses `order_sequence_number`, but WS snapshot objects use `orderSequenceNumber`), `priceTicks` vs `price_in_ticks`.

**Recommendation:** Commit to one convention for the JSON wire format and apply it uniformly via `#[serde(rename_all = "camelCase")]` or `#[serde(rename_all = "snake_case")]` on all types. Document which convention is canonical.

### 4. JavaScript u64 Precision Loss — Medium Impact

`order_sequence_number` and `price_in_ticks` are u64 values that exceed JavaScript's `Number.MAX_SAFE_INTEGER` (2^53). We had to add a custom Serde deserializer in our Rust backend to accept both strings and numbers:

```rust
fn deserialize_u64_or_string<'de, D>(d: D) -> Result<u64, D::Error> {
    enum StringOrU64 { Num(u64), Str(String) }
    // ...
}
```

Notably, the SDK already has a `JsSafeU64` wrapper type (`types/src/js_safe_ints.rs`) that serializes as string — but it's not applied to all u64 fields. `order_sequence_number` and `price_ticks` in WS payloads (`trader.rs:195, 200`) use it, but the REST cancel order flow doesn't consistently enforce it.

**Recommendation:** Apply `JsSafeU64` to all u64 fields across all endpoints. This is standard practice for blockchain APIs (Solana's own JSON-RPC serializes u64 as strings).

### 5. Trade Stream Missing Computed Price — Low-Medium

The WebSocket trade stream provides `quote_amount` and `base_amount` separately. We have to derive price:

```rust
let price = if t.base_amount > 0.0 {
    t.quote_amount / t.base_amount
} else {
    0.0  // silent fallback
};
```

**Recommendation:** Include a `price` field in the trade stream. Every consumer will compute it the same way — save them the division and the edge case handling.

### 6. Mark Price Not in Position Data — Medium

Position objects don't include the current mark price. We have to fetch it from a separate WebSocket subscription and inject it reactively:

```typescript
// traderStore.ts
mark_price: 0,  // Always 0 — injected from statsStore later

// Positions.tsx — reactive injection
const positions = rawPositions.map((pos) => ({
  ...pos,
  mark_price: markPrices[pos.symbol] ?? 0,
}));
```

This creates a window where positions render with stale or zero mark prices, especially during market switches.

**Recommendation:** Include `mark_price` in position data, even if it's the price at query time.

### 7. No Batch Operations Support — High Impact

**Workaround Implemented:** We built a custom `/api/tx/close-all-positions` endpoint that combines multiple market order instructions into a single transaction. However, this has significant limitations:

1. **Cross-margin only works efficiently** — Cross-margin positions use `PhoenixTxBuilder::build_market_order()` which is synchronous and fast
2. **Isolated positions require async HTTP calls** — Each isolated position needs a separate `build_isolated_market_order_tx()` call to the Phoenix HTTP API, making batching slow and complex
3. **Transaction size limits** — We had to implement a conservative limit (24 instructions ~ 6 positions) to avoid Solana's ~1232 byte transaction size limit
4. **Mixed margin modes are problematic** — Cross-margin orders can be built locally, but isolated orders require async network calls, making it impossible to batch both types atomically without complex orchestration

**Current Implementation:**

```rust
// Our workaround in ember-backend/src/routes/trade.rs
// - Separate cross-margin and isolated positions
// - Build cross-margin instructions synchronously
// - Build isolated positions via async HTTP calls
// - Combine all instructions and check size limits
// - Return single transaction for one signature
```

**The Problem:** Closing 5 positions used to require 5 separate wallet signatures (one per transaction). With our workaround, it requires 1 signature, but we're building instructions through two different code paths with different latency characteristics.

**Recommendation:** Add native batch operation support to the SDK:

```rust
// Ideal SDK API
let instructions = builder.build_batch_market_orders(vec![
    BatchOrderItem { symbol: "SOL", side: Side::Ask, size_lots: 100, subaccount_index: 0 },
    BatchOrderItem { symbol: "BTC", side: Side::Bid, size_lots: 50, subaccount_index: 0 },
    // ... more orders
])?;
// Returns all instructions in a single Vec for one transaction
```

This would:
- Enable true atomic batch operations
- Eliminate the cross-margin vs isolated complexity for batching
- Allow the SDK to optimize instruction packing
- Provide consistent error handling for partial failures
- Make "Close All Positions" a first-class feature rather than a workaround

---

## Documentation Gaps

### Missing Entirely

| Topic | Impact | Notes |
|-------|--------|-------|
| **Error handling guide** | Critical | Zero documentation on error types, recovery strategies, or retry patterns |
| **Isolated margin walkthrough** | High | Docs say "not supported" but the API works — contradictory and confusing |
| **WebSocket reconnection behavior** | Medium | What happens to subscriptions on reconnect? Are they restored? |
| **Anchor error codes** | Critical | No mapping of `Custom:6001`, `Custom:6002` etc. to human-readable errors |
| **Instruction count per operation** | Medium | How many IXs does deposit produce? Withdraw? Isolated order? |
| **Real-world workflows** | High | No end-to-end examples (place order → monitor → cancel → withdraw) |

### Partially Documented

| Topic | What's There | What's Missing |
|-------|-------------|----------------|
| TxBuilder methods | Method signatures | When to use each, instruction counts, error conditions |
| WS subscriptions | Subscribe calls | Lifecycle management, handle semantics, multi-market patterns |
| HTTP pagination | Query params | How to iterate all pages, cursor expiry, max page size |
| Rate limiting | Retry config | Rate limit thresholds, per-endpoint limits, burst allowances |

### Contradictions

The `rise.mdx` introduction states: **"Does not support isolated accounts/orders"**. But:
- `build_isolated_market_order_tx()` exists and works
- `build_isolated_limit_order_tx()` exists and works
- We shipped isolated margin to production using these methods

This is the single most confusing thing in the docs. Either update the docs or explicitly mark it as experimental.

---

## On-Chain Error Codes

This was our biggest debugging time sink. When a transaction fails on-chain, Solana returns:

```json
{"InstructionError": [6, {"Custom": 6001}]}
```

There is **no documentation** mapping custom error codes to meanings. We had to reverse-engineer from the Anchor IDL:

| Code | Meaning | How We Discovered It |
|------|---------|---------------------|
| 6001 | InsufficientFunds (margin) | Reading Anchor error enum, testing with known margin states |
| 6000 | (First custom error) | Inference from 6001 being second |

The instruction index (6 in the example) also shifts based on Phantom wallet's transaction boost (which prepends ComputeBudget instructions), making debugging even harder.

**Recommendation:**
1. Publish a complete error code table in the docs
2. Consider adding a `decode_error(code: u16) -> &str` utility to the SDK
3. Document that wallet-injected instructions shift the error index

---

## Specific Bug Reports

### 1. Trader State Silent Parse Failures

In `sdk/src/types/trader.rs`, the `Trader::apply_update()` method (around line 42) uses `.parse().unwrap_or(0)` for critical fields like position size, collateral, and entry price. If the API changes field format or sends unexpected data, trader state silently falls back to zeros with no error or warning:

```rust
// This should at least log a warning — silent zeros are dangerous for a trading app
let size: f64 = row.get("size").unwrap_or("0").parse().unwrap_or(0.0);
```

### 2. Subscription Handle Semantics Undocumented

Dropping a `PhoenixSubscriptionHandle` silently unsubscribes. This is elegant but surprising — we lost data for 30 minutes before realizing a handle was being dropped in a scope exit. The `_keep_alive` pattern should be documented prominently.

### 3. Deposit Instruction Count Assumption

Documentation mentions 3 instructions for deposit, 5 for withdraw. But if trader registration is needed (first-time user), deposit becomes 3 + N registration instructions. We handle this by querying `get_traders()` first, but this adds latency.

---

## What Would Help the Next Developer

### Quick Wins (< 1 day of work)

1. **Error code table** — map every `Custom:XXXX` to a human-readable string
2. **Fix the "isolated not supported" contradiction** in rise.mdx
3. **Add `price` field to trade stream** — every consumer computes it identically
4. **Document subscription handle lifecycle** — one paragraph saves hours of debugging
5. **Standardize JSON field naming** — pick camelCase or snake_case, not both

### Medium Effort (1-3 days)

6. **Make `build_bracket_leg_orders` public** or fold TP/SL into `build_limit_order()`
7. **Add error handling guide** with recovery patterns for each error type
8. **Serialize u64 as strings** in all JSON responses
9. **Standardize numeric format** across all endpoints (Decimal object vs plain number)
10. **Add `decode_error()` utility** that maps Anchor error codes to messages

### Larger Improvements (1+ week)

11. **End-to-end workflow examples**: place order → monitor position → cancel → withdraw
12. **Pre-validation methods**: `can_place_order()` that checks margin before building IX
13. **Typed order IDs**: wrapper types for `OrderSequenceNumber` and `PriceInTicks` instead of raw u64
14. **Include mark price in position data** from REST and WS trader state
15. **Expose free collateral** (collateral minus initial margin) in trader state — we had to compute `freeCollateral = effectiveCollateral - initialMargin` ourselves, and getting it wrong caused repeated `Custom:6001` failures in production when users placed multiple trades in a row. The SDK's `TraderView` (`trader_http.rs`) exposes `effective_collateral` and `initial_margin` separately, but no `available_collateral` field — every frontend will need to derive it, and every one risks the same bug we hit

---

## Time Spent on SDK Issues

| Issue | Debug Time | Resolution |
|-------|-----------|------------|
| Custom:6001 error decoding | ~4 hours | Reverse-engineered Anchor error enum |
| Bracket leg private API | ~3 hours | Reimplemented 103 lines from SDK source |
| Numeric format inconsistency | ~2 hours | Wrote `sdkNum()` defensive parser |
| camelCase/snake_case | ~2 hours | Double-fallback chains everywhere |
| Subscription handle drops | ~1 hour | `_keep_alive` pattern discovery |
| Isolated margin "unsupported" | ~1 hour | Tried it anyway — it works |
| u64 precision loss | ~1 hour | Custom deserializer |
| Free collateral computation | ~2 hours | Caused production Custom:6001 bugs |
| **Total** | **~16 hours** | ~30% of hackathon time on SDK friction |

---

## Summary

The Phoenix SDK is a **strong foundation** that enabled us to build a complex trading terminal in 3 days. The transaction builder, WebSocket client, and HTTP client are well-designed and functional. The main areas for improvement are:

1. **Documentation** — especially error codes, isolated margin, and real-world workflows
2. **Consistency** — field naming (camelCase vs snake_case) and numeric formats
3. **API surface** — make bracket leg builder public, add pre-validation methods
4. **Developer experience** — error decode utility, mark price in positions, free collateral in trader state

We'd happily build on Phoenix again. With the documentation and consistency improvements above, the next team could save 16+ hours and ship even faster.

---

*Report compiled by the Ember Terminal team — March 2026*
