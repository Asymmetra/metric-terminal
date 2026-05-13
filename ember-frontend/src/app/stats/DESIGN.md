# Observability Page — Design

> Living design doc for the `/stats` observability page. This is the
> canonical reference for what the page is, what it tries to be, how
> the pieces fit together, and what's still to do. Update this file
> when the architecture shifts.

## 1. Purpose

`/stats` is an **internal-use observability dashboard + API playground**.
It serves three audiences, all internal:

1. **Operator** — wants to see at a glance whether every data feed
   Ember consumes is healthy, where the latency is, and what's stale.
   The page should answer "is anything broken right now?" in ≤ 5 seconds.
2. **Developer porting a feed elsewhere** (e.g. the React Native
   mobile app, a future bot, a research notebook) — wants to find a
   single source, see the actual payload shape, copy a minimal code
   snippet, and have working code in their other project in minutes.
3. **Researcher / analyst** — wants to leave the page open across
   hours of trading, then look back at the cadence patterns,
   spreads, and recent payloads to characterize behavior.

These three audiences share a screen but have very different needs.
The information architecture (§4) is built around that overlap.

## 2. Non-goals

- **Not for end users.** This is a dense, internal screen. No
  hand-holding, no marketing copy, no rate limiting. Auth is
  intentionally absent (the data shown is already public).
- **Not a metrics store.** We don't ship anything to a TSDB. State
  lives in memory while the tab is open; localStorage gives us a
  warm restart but not historical analytics across days.
- **Not a backend that any other service should depend on.** All
  ingestion happens client-side; nothing on `/stats` should be load-
  bearing for a production code path.
- **No new indexing.** We only surface data Phoenix or our backend
  already exposes. We do not aggregate or denormalize server-side.

## 3. Audience-driven success metrics

For each audience, the page is successful if the answer to its
canonical question fits comfortably in the visible viewport:

| Audience | Canonical question | Where it's answered |
|----------|--------------------|---------------------|
| Operator | "Is anything broken right now?" | Top-bar category dots + colored health badges on every row |
| Developer | "How do I consume this feed from my other service?" | Detail tray → Code tab → copy snippet |
| Researcher | "How variable is the cadence of this feed?" | Detail tray → Cadence panel → percentiles + sparkline + raw samples |

If any of these answers takes more than two clicks or requires
opening DevTools, that's a UX bug. File it.

## 4. Information architecture — 5-layer hierarchy

The page deliberately hides depth behind progressive disclosure. From
glance-level to expert-level, each layer answers more specific
questions:

### Layer 1 — Global health (always visible, top bar)

- One dot per category (`Phoenix WS`, `Phoenix REST`, `Ember WS`,
  `Ember REST`). Color reflects worst-case status across that
  category's sources.
- Cumulative counters: total messages, msgs/sec (60s avg), uptime,
  reconnect count.
- Pause / Reset / Search controls.

**Design intent**: a triage screen. If you only have 2 seconds, the
dots tell you whether you need to look closer.

### Layer 2 — Channel filters (chips, just under the top bar)

- One chip per `SourceKind`. The chip shows the kind's active source
  count.
- Click to hide that kind from the table. Subscriptions stay live —
  cadence stats keep accumulating in the background.
- High-volume kinds (`orderbook`, `trades`, `candles`) default
  hidden so the page is readable on first load. Operators toggle
  them on when they want to look closer.

**Design intent**: let the user choose the density of their workspace
without losing data underneath.

### Layer 3 — Category sections (collapsible, full-width)

Each category gets its own collapsible block. Header shows:
- Section title + one-line explanation of the category's transport
- Healthy / degraded / stale / total counts
- A toggle to collapse the section

Empty categories (no sources wired) are hidden entirely; they
re-appear automatically when sources of that category come online.

**Design intent**: keep related sources together; preserve vertical
real estate by collapsing categories the operator isn't currently
focused on. Phoenix-WS will usually be expanded; Ember-REST might
collapse once you trust it.

### Layer 4 — Source table rows

One row per `DataSource`. Columns chosen so an operator can scan a
row and answer "is this OK?" in two cells (Status badge + p95 cell,
both color-coded). The row also previews the latest payload in a
kind-specific format so the row is informative even before opening
the tray.

Columns: Source · Latest · Mark−Oracle · Age · Count · N/60s · Gap p50 ·
Gap p95 · Gap max · Status. Click a row to open the detail tray.

**Critical naming choice**: "Age" vs "Gap p50". These look like the
same number but mean different things. Age = how stale the freshest
value is right now (resets to 0 on every message). Gap p50 = median
time between messages. If Phoenix publishes every 1s, Age randomly
falls in [0, 1s] while Gap p50 ≈ 1000ms. Tooltips on every column
header explain this.

### Layer 5 — Detail tray (slide-out, right side)

The deep-dive view. Three tabs (Code / Payload / History) plus two
persistent panels above them:

- **Market Snapshot** (only for `phoenix-ws-market` sources): the
  three prices in big type with hover-revealable definitions, three
  spread cells (mark−oracle, mid−oracle, mid−mark) in $ and bps,
  and the four major analytics (OI, 24h volume, funding, 24h
  change). Captures why oracle / mark / mid are different and what
  each is used for.
- **Cadence & latency**: the six aggregate stat boxes (Age now /
  Gap p50–p99 / max / rate) followed by an SVG sparkline of the
  raw inter-arrival samples with the p50 reference line, plus a
  collapsible list of raw values. This is where the percentile math
  becomes legible.

The three tabs:
- **Code** — copy-paste snippets in TypeScript / Rust / cURL, with a
  tab-per-language. The language choice persists across rows.
- **Payload** — pretty-printed latest payload.
- **History** — newest-first list of recent payloads (capped per
  kind, see §6).

**Design intent**: every source is a self-contained demo. A
developer should be able to open the tray, hit copy, and have
working code in their other project.

## 5. API playground workflow

The page doubles as a "find-and-replicate" tool for porting feeds.
Canonical workflow:

1. Operator opens `/stats`.
2. Searches the filter bar for the asset/symbol they need (e.g.
   `SOL · market`).
3. Clicks the row → tray opens on the right.
4. Confirms the **Market Snapshot** and **Payload** tabs show what
   they expect (this is the "are we even getting the data I think
   we're getting?" sanity check).
5. Clicks the **Code** tab → picks TypeScript or Rust.
6. Hits **Copy** → pastes into the other project.
7. (Optional) keeps the page open as a reference while integrating.

The snippets are designed to be the **minimum runnable code**, not
illustrative pseudocode. A developer should be able to paste a
TypeScript snippet into a fresh `index.ts`, run it, and see the
exact same payloads streaming. The Rust snippets use the public
`phoenix-rise` crate; the TS snippets use built-in `WebSocket`
(not the npm SDK) to maximize portability — including React Native.

Future expansion (§10): make the snippets adapt to user-selected
language, symbol substitution, and optional features (auth headers,
authority pubkeys, etc.).

## 6. Data sources — completeness matrix

| Source | Category | Kind | Wired? | Notes |
|--------|----------|------|--------|-------|
| `subscribe_to_market(symbol)` per market | Phoenix WS | `phoenix-ws-market` | ✅ | Auto-subscribed for every Phoenix market. Primary oracle feed. |
| `subscribe_to_all_mids` | Phoenix WS | `phoenix-ws-all-mids` | ✅ | Heartbeat reference. |
| `subscribe_to_funding_rate(symbol)` | Phoenix WS | `phoenix-ws-funding` | ✅ | Auto-subscribed. |
| `subscribe_to_orderbook(symbol)` | Phoenix WS | `phoenix-ws-orderbook` | ✅ | Auto-subscribed; hidden by default in the table. |
| `subscribe_to_trades(symbol)` | Phoenix WS | `phoenix-ws-trades` | ✅ | Auto-subscribed; hidden by default. |
| `subscribe_to_candles(symbol, 1m)` | Phoenix WS | `phoenix-ws-candles` | ✅ | Auto-subscribed; hidden by default. |
| `GET /exchange` | Phoenix REST | `phoenix-rest-exchange` | ⏳ | Descriptor + snippets defined; no poller yet. |
| `GET /orderbook/{symbol}` | Phoenix REST | `phoenix-rest-orderbook` | ⏳ | Same. |
| `GET /api/markets` | Ember REST | `ember-rest-markets` | ✅ | Polled every 30s. Drives the symbol-list refresh / auto-discovery. |
| `GET /health/memory` | Ember REST | `ember-rest-health-memory` | ✅ | 30s poll. |
| `GET /health/relay` | Ember REST | `ember-rest-health-relay` | ✅ | 30s poll. |
| `GET /health/ws` | Ember REST | `ember-rest-health-ws` | ✅ | 30s poll. |
| `GET /api/trader/{pubkey}` | Ember REST | (proposed) | ❌ | Needs wallet connect; gate behind wallet-required flag. |
| `GET /api/trader/{pubkey}/orders` etc | Ember REST | (proposed) | ❌ | Same. |
| `GET /api/candles/{symbol}` | Ember REST | (proposed) | ❌ | Compare with Phoenix direct candles. |
| `WS stats:{symbol}` (ember relay) | Ember WS | `ember-ws-stats` | ❌ | Compare-via-backend kind. Descriptor + snippets defined; not subscribed. |
| `WS orderbook:{symbol}` | Ember WS | `ember-ws-orderbook` | ❌ | Same. |
| `WS trades:{symbol}` | Ember WS | `ember-ws-trades` | ❌ | Same. |
| `WS candles:{symbol}` | Ember WS | `ember-ws-candles` | ❌ | Same. |

**Auto-discovery contract**: when Phoenix lists a new perp, our
backend's `/api/markets` reflects it within at most one poll
interval. The page's symbol-list effect re-runs whenever that array
changes; `useObservability` re-broadcasts the full subscription set
to Phoenix's WS. Net: new Phoenix perps appear on `/stats` with no
human action, with at most ~5 minutes of latency.

## 7. Live analytics — what's tracked, how it's computed

For every source, on every successful arrival the hook records:

- Performance.now() timestamp of arrival
- Inter-arrival delta (vs the previous arrival), pushed onto a
  256-sample ring buffer
- The payload itself, pushed onto the recent-payloads ring (capped
  per kind — see §8)

Every 500ms the tick effect snapshots refs → React state. At that
boundary it computes:

- `p50 / p95 / p99 / max` of the inter-arrival ring (sort + index)
- `count60s` (the size of the ring, since we cap at 256)
- `rate60s` (msgs/sec over the last 60s window — tracked on a
  separate ring of cumulative timestamps)
- `ageSec` (now − lastUpdateAtMs)
- `status` via `classifyHealth(...)` — see §7.1

The hook never re-renders on per-message arrival. The 500ms tick is
the only thing that pushes React state, which is what keeps the
page responsive when ~150 sources are pushing simultaneously.

### 7.1 Health classification

```
stale    → age > max(30s, 6×expectedCadenceMs)
degraded → age > max(5s,  2×expectedCadenceMs)
        OR p95 > max(2s,  3×expectedCadenceMs)
healthy  → otherwise (and has had activity)
idle     → no activity yet, no errors
error    → errored (only REST poll kinds set this today)
```

Each source carries an `expectedCadenceMs` so a once-per-30s REST
poll isn't measured against the same 2-second threshold as a 1Hz WS
stream. This is the single most important detail in the file — if
you change a kind's cadence expectation, the colors change with it.

## 8. Historical tracking strategy — three tiers

| Tier | What | Where | When dropped |
|------|------|-------|--------------|
| Ephemeral | Per-message inter-arrival samples | In-memory ring (256 samples) | Tab close / reset |
| Warm | Recent payloads | Memory + localStorage | Tab close clears memory; localStorage survives refresh |
| Cold (manual) | Full per-message log | CSV export → user's downloads folder | User controls |

### 8.1 In-memory ring

The inter-arrival ring is the high-frequency source of truth for
percentiles. 256 samples × ~1Hz = ~4 minutes of cadence history
during steady-state. For lower-cadence sources (funding at one
per-epoch) the ring covers hours.

### 8.2 localStorage warm restart

Saved every 5s under `ember-observability-v1`:
- Per-source cumulative count + errorCount
- Per-source recentPayloads tail (capped per kind, see below)
- UI preferences (paused, expanded categories, selected source,
  preferred snippet language)

NOT saved:
- Per-message inter-arrival samples (large, low value on restart)
- WS connection state (recreated)
- `orderbook` and `trades` payloads (full L2 books are too large
  for the 3MB budget)

Budget enforcement: if the JSON document is over 3MB, trim the
largest source's payload tail in half repeatedly until under budget,
then write. Quota-exceeded errors fall back to dropping the key.

### 8.3 Per-kind recent-payload caps

| Kind | History cap |
|------|-------------|
| `phoenix-ws-orderbook` | 10 |
| `phoenix-ws-trades` | 20 |
| `phoenix-ws-candles` | 30 |
| Everything else | 100 |

Tuned to keep the in-memory footprint bounded across ~150 sources
while leaving low-volume sources rich enough for scrollback.

### 8.4 CSV export

Page-level button. Dumps every source's recentPayloads tail to one
CSV the user downloads. Format intentionally raw — a spreadsheet or
notebook can do its own analysis.

## 9. UX patterns — when to use what

The page has a LOT of information. The right pattern depends on
how often the user needs to see the data:

- **Always visible** → top bar (global state, controls), table
  columns (per-source one-liners).
- **One click away** → category collapse (per-category density),
  detail tray (per-source deep dive).
- **Hover-revealable** → column header tooltips (formula
  explanations), price-cell tooltips (oracle vs mark vs mid
  definitions), per-row tooltips (full latest payload truncated to
  400 chars).
- **Two clicks away** → tabs inside the detail tray (Code / Payload
  / History) and the collapsible "raw values" in the cadence panel.

Rule of thumb when adding new data:
- If it's a single number visible per-row at-a-glance → table column.
- If it's a per-source detail people will want occasionally → tray.
- If it's a definition / explanation / formula → hover tooltip.
- If it's bulk historical data → tab inside the tray.

## 10. Roadmap

Grouped by user value, in approximate priority order. Each item is
intentionally small enough to ship independently.

### 10.1 High-value next steps

- **Wire Phoenix REST endpoints** (`/exchange`, `/orderbook/{symbol}`)
  with poll cadence. Descriptors + snippets already exist.
- **Wire Ember WS comparison channels** (`stats:{symbol}`,
  `orderbook:{symbol}`, etc) so the operator can see direct-from-
  Phoenix vs relayed-by-ember side-by-side. Catches relay bugs.
- **Symbol filter / grouping toggle** in the table — let the
  operator group by symbol rather than by kind, useful when they
  want to see "everything we know about SOL right now."
- **Anomaly highlight** — when p95 spikes 3× over its trailing
  median, flash the row. Catches the start of an incident faster
  than scanning.

### 10.2 Developer-experience polish

- **Symbol substitution in snippets** — current snippets default
  to the row's symbol; let the user type a different symbol in the
  tray and re-generate.
- **Rust raw-tungstenite snippet** for users who don't want the
  full `phoenix-rise` SDK dep.
- **Python snippet** (websockets / requests) for notebook users.
- **Snippet diff** — show the delta when switching languages so
  the operator can see "here's what this section does in TS vs
  Rust" side-by-side.

### 10.3 Historical / analytics

- **Per-source mini-history chart** in the table row — a tiny
  4-cell sparkline of the last 60 cadence samples so you can spot
  trends without opening the tray.
- **Cross-source overlay** — pick 2 sources, see their cadence
  sparklines on one chart. Useful for direct-vs-relay comparisons.
- **Persistent recording mode** — opt-in flag that increases the
  in-memory ring to 4k samples (~hours), at the cost of memory.

### 10.4 Operational

- **Channel-toggle persistence** — the channel filter chips don't
  yet persist to localStorage. Cheap fix.
- **Bandwidth meter** — bytes/sec received from each WS,
  approximated from message lengths. Useful when debugging "why
  is the page slow?"
- **Force-disconnect / reconnect buttons** per WS so operators can
  test reconnect behavior interactively.
- **A way to subscribe to a specific symbol's trader_state** — not
  done because it needs wallet pubkey input. Right now we don't
  surface this kind at all; could add a small form in the tray.

### 10.5 Cross-asset & analytics layer

- **Top-of-table market overview strip** — a horizontal carousel of
  per-symbol price tiles (price, 24h change, OI) sorted by movement.
  Today this data is only visible if you open the detail tray for
  one market at a time; surface it at-a-glance for everything.
- **Spread time-series per symbol** — chart of `mark − oracle` and
  `mid − oracle` drifting over the rolling window. Detail tray shows
  the current spreads but the trend is more informative.
- **Funding countdown** — funding settles at 0/8/16 UTC; show the
  countdown next to the funding-rate cell so the operator knows
  when the next settlement print is due.
- **Volume velocity** — derivative of `dayNtlVlm` over recent
  minutes. Highlights unusually busy markets even when the absolute
  volume number is small (microcap markets where 50× the usual
  velocity still rounds to a small $ number).
- **Correlation matrix tab** — pair-wise return correlation across
  symbols over a rolling window. Useful as a research/sanity tool.
- **Direct on-chain oracle comparison** — read Pyth/Switchboard
  accounts via the Solana RPC (read-only, the public RPC is fine)
  and compare against Phoenix's reported `oracle_price`. Validates
  whether Phoenix's oracle tracks the source. Adds the rpc latency
  channel as a new category.

### 10.6 Stretch

- **WebRTC-style bottom-tray "raw event log"** with search and
  pause. Useful for forensic debugging of one specific message.
- **Diff view of two payloads** in the History tab — pick two
  adjacent payloads, see what fields changed.
- **Schema validation** — fetch the SDK's TypeScript types at build
  time and validate incoming payloads, flag any payload that
  doesn't match Phoenix's documented schema.

### 10.7 Audit (2026-05-13) — concrete additions and what was just fixed

**Mid-session iteration (same date) — three more landed:**

- **Per-symbol consolidation in the Phoenix WS table.** Rows are now
  one-per-asset instead of one-per-(asset, channel). Market / funding /
  orderbook / trades / candles for SOL collapse to a single "SOL" row
  whose Latest / Spread / Age / Cadence come from the market channel
  (the primary). A "5 ch" pill next to the symbol indicates merged
  rows; allMids and single-channel symbols pass through unchanged. The
  detail tray gained a channel-switcher pill bar in its header so you
  can hop between channels for the same asset without closing the tray.
- **Reduced column count.** Main table is now 6 columns:
  `Source · Latest · Spread · Age · Cadence · Status`. The richer
  per-channel detail (Count, N/60s, Gap p95, Gap p99, Gap max, rate,
  sparkline, raw inter-arrival samples) all live in the detail tray's
  Cadence panel. Glanceable on the main screen; drill in for depth.
- **Fixed-width numeric rendering.** Every numeric value (Age, Cadence,
  Spread) is split into a fixed-width number slot + fixed-width unit
  slot via the new `NumberUnit` helper. Combined with `tabular-nums`
  and `table-layout: fixed`, this removes both the column wobble
  *and* the in-cell wobble where the left edge of right-aligned text
  shifted as character count changed.
- **Instant CSS tooltips.** Native `title=` attributes have a
  ~700ms-1s browser-driven appearance delay; replaced with a CSS-only
  `group-hover` popover that fires the moment the cursor enters the
  cell. Applied to all detail-tray cells and column-header tooltips.

**Subscription scope fix — accurate cadence metrics:**

The page used to subscribe to *every* Phoenix channel for every market
even when channels were hidden via the chip toggle. With 29 markets ×
6 channels, that's ~175 active streams competing for the single
Phoenix WS connection. Orderbook alone publishes ~10Hz × 29 markets ≈
290 msgs/sec; that traffic queues ahead of the 1Hz market messages on
the browser's WS receive buffer, inflating the perceived inter-arrival
gap of the channels the user actually cared about. p50 for market
drifted from ~1s (clean) to ~3.5–4s (congested).

Fix: a subscription reconciler in `useObservability` that diffs
*desired* subscriptions (= enabled kinds × symbols + the always-on
allMids) against *current* subscriptions and sends only the deltas.
Default chip state subscribes to market + funding + allMids ≈ 58
streams; toggling orderbook ON sends 29 new subscribes; toggling it
OFF sends 29 unsubscribes. Cadence numbers for the channels we DO
show are now accurate — they reflect Phoenix's actual publish rate,
not our own bandwidth contention.



A fresh pass over what `/stats` does today vs the data Phoenix and
our backend actually expose. Anchored against §6's completeness
matrix; items here are not yet captured in §10.1–10.6 or expand them
with new detail.

**Fixed this revision**
- **Boot-up TTFD reduced from ~5s to sub-500ms.** Was: a single
  synchronous burst of 145 subscribe messages on WS open (29 markets
  × 5 channels + allMids). Phoenix's server queued them, and no data
  flowed until the queue drained. Now: staggered in 3 phases —
  market+allMids immediately, funding at +250ms, orderbook/trades/
  candles at +750ms. The kinds visible by default flow first.
- **Column-width jitter eliminated.** Was: `<table>` auto layout
  re-measuring on every paint as decimal counts changed. Now:
  `table-layout: fixed` + explicit colgroup widths + `tabular-nums`
  on every numeric cell. Cells truncate with ellipsis instead of
  reflowing the row.

**Coverage audit — what's present today**

| Layer | Present | Missing |
|-------|---------|---------|
| Phoenix WS market channels | ✅ all 6 channels × all symbols | trader_state (needs pubkey input) |
| Phoenix REST | descriptors only | live polls for `/exchange`, `/orderbook/{sym}`, `/markets/{sym}/stats-history` |
| Ember REST | `/api/markets`, three `/health/*` | `/api/orderbook/{sym}`, `/api/candles/{sym}`, `/api/leaderboard`, `/api/onboard/check`, trader-state family |
| Ember WS relay | none subscribed | comparison-only sources for relay-vs-direct latency check |
| Browser-side analytics | cadence percentiles, spreads | no derived series (funding countdown, velocity, top-movers carousel) |
| Wallet-aware sources | none | trader_state, /api/trader/{pk}/* (gate behind wallet connect) |
| Deployment metadata | none | commit SHA, build time, region surfaced in header so the operator knows what they're testing |

**New candidate additions not yet covered above**

1. **Deployment header pill** — show `${commitSha.slice(0,7)} ·
   ${deployRegion} · built ${buildTimeIso}` in the top bar. Cheap
   (Vercel injects the env vars at build time), high signal for
   "is this the change I expected to be testing?".
2. **Filter by status** — chip row next to the search box: "healthy
   / degraded / stale / error / idle". Click to scope the table.
   Useful when triaging.
3. **Per-row symbol-grouped layout** — sibling to the current
   category grouping; when on, every market shows one accordion
   block with all 6 kinds nested inside. Better for "tell me
   everything about SOL right now" than the per-category view.
4. **Live oracle-vs-mark divergence alert** — flash any row whose
   `|mark − oracle| / oracle` exceeds a threshold (e.g. 0.5%).
   Phoenix uses an EMA-smoothed mark; large divergence usually
   means the oracle just jumped. First-line indicator that
   something interesting is happening on chain.
5. **Bandwidth + msg-rate tile** — per-WS, bytes/sec and msgs/sec
   computed from message lengths. Catches "page is slow because
   orderbook payloads are huge today" before it becomes a mystery.
6. **Backend richer health** — extend `/health/memory` to also
   include RSS, heap, request-rate, and active-WS-connection
   counts. Single REST source on the page gains a payload tab full
   of system metrics.
7. **Pause-per-source** — today Pause is global. Per-source pause
   would let the operator freeze one weird stream while keeping
   everything else live.

These are intentionally bite-sized; pick the highest-value subset
for the next pass rather than trying to land all of them.

## 11. Known limitations

- **No auth.** Anyone with the URL can see the page. Acceptable
  because the data is public anyway, but anyone scraping the page
  also gets our backend `/health/memory` (which leaks process RSS
  details). Consider basic auth or Vercel preview-only if that ever
  matters.
- **localStorage is per-origin.** Refreshing across the
  ember-terminal-gamma.vercel.app vs ember-terminal-asymmetra.vercel.app
  aliases would create two separate buckets. Not worth solving
  unless someone actually splits sessions.
- **Per-symbol history accumulates.** A user who leaves the tab
  open for days will eventually have a large set of recentPayloads
  per market source. The 3MB budget enforcement trims this but
  it's coarse. Better long-term: explicit per-source history
  rolling window in wall-clock time, not just count.
- **No backpressure handling on Phoenix WS.** If the WS pushes
  faster than the tick can flush, snapshot data lags by up to
  500ms. Acceptable for a monitoring screen but not for anything
  that actually trades.
- **Channel filter is UI-only.** We still ingest hidden kinds —
  that's intentional so cadence stats stay warm. But on a memory-
  constrained device this could be wasteful. Future toggle:
  unsubscribe-not-just-hide.

## 12. File map

```
ember-frontend/src/app/stats/
  page.tsx                          # composition root
  DESIGN.md                         # this file

ember-frontend/src/hooks/
  useObservability.ts               # registry + WS + REST pollers + persistence

ember-frontend/src/lib/observability/
  types.ts                          # DataSource taxonomy + per-kind caps
  snippets.ts                       # per-kind code generators
  persistence.ts                    # localStorage save/load with budget

ember-frontend/src/components/stats/
  SourceTable.tsx                   # grouped + collapsible + filterable
  SourceDetailTray.tsx              # slide-out detail (market / cadence / tabs)
  CodeBlock.tsx                     # multi-lang snippets with copy button
  Sparkline.tsx                     # SVG inter-arrival viz
```

When adding a new source kind, the minimum touchpoints are:

1. Add the kind to `SourceKind` in `types.ts`.
2. Add a snippet generator branch in `snippets.ts`.
3. Add a descriptor factory branch in `useObservability.ts:makeDescriptor`.
4. Add subscribe / poll wiring in the same file.
5. (Optional) add a preview formatter branch in `SourceTable.tsx:previewLatest`.
6. (Optional) add a market-snapshot section in `SourceDetailTray.tsx`
   if the payload deserves a specialized view.

That's it. The rest of the page picks up the new source automatically.

## 13. How to use this doc

If you change the page's architecture, update this file in the same
commit. If you're skimming, sections 1 / 4 / 6 / 10 cover purpose,
information architecture, what's wired, and what's next.
