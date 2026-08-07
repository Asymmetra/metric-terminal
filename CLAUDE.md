# CLAUDE.md

This file is read automatically by Claude Code. The full guidance for agents lives
in [`AGENTS.md`](./AGENTS.md) — read it first.

## TL;DR

`metric-terminal` is a proof-of-concept perpetuals terminal built entirely on top
of [Imperial](https://api.imperial.space/api/v1/openapi.json) (a passthrough router
over Phoenix / Jupiter / Flash / GMTrade + Imperial Pairs & Touch). Isolated-margin
only (profiles 0..5 per wallet).

- `metric-frontend/` — Next.js frontend (TypeScript, Tailwind v4).
- `metric-backend/` — Rust/Axum thin proxy + WS fan-out + candle aggregation.

## Hard rules

1. **No simulated/fake data** — real API calls only.
2. **Backend never signs** — tx-building endpoints return an unsigned tx the client
   signs; the `SignerProvider` interface is the swap point.
3. **Imperial is upstream** — proxy/derive, don't re-implement its endpoints.
4. **Before committing:** run `npx tsc --noEmit` + `npm test` (frontend) and
   `cargo clippy -- -D warnings` + `cargo test` (backend).
5. **All testing is automated** — no manual/human steps required to prove correctness.

See [`AGENTS.md`](./AGENTS.md) for the repo map, key files, and the Imperial
concepts (auth, per-venue price scales, underwriter enum, WS quirks), and
[`README.md`](./README.md) for the deep integration notes.
