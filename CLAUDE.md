# Metric Terminal — Project Rules

## CRITICAL: No Worktrees

**Worktrees are DISABLED.** Do not create git worktrees, do not use `git worktree add`, do not use Pentagon worktree isolation. All agents work directly on the main repository:

- **Working directory**: `/Users/liamdig/Desktop/sandbox/Asymmetra/metric-terminal`
- **Branch**: `main` (always)
- **No feature branches** — commit directly to main
- **No worktrees** — they have been removed and must not be recreated

If your tooling or workflow attempts to create a worktree, override it. Work in-place on main.

## Repository Structure

- `metric-frontend/` — Next.js frontend (TypeScript, Tailwind v4)
- `metric-backend/` — Rust/Axum backend (calls Imperial — `https://api.imperial.space/api/v1`)
- `.keys/test-wallet.json` — Test wallet keypair (pubkey: HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x). Currently funded with ~0.08 SOL + ~10 USDC on mainnet for live-trade integration testing. Path is gitignored; copy from the original ember-terminal repo at `/Users/liamdig/Desktop/sandbox/ember-terminal/.keys/test-wallet.json` if missing.

## Upstream

This is a fork of Ember Terminal (Phoenix-Rise SDK PoC). It has been retargeted to use **Imperial** — Asymmetra's passthrough router that brokers trades across Phoenix, Jupiter, Flash Trade, and GMTrade. Isolated-margin only (profiles 0..5 per wallet).

Imperial OpenAPI: https://api.imperial.space/api/v1/openapi.json

## Production Endpoints

- **Frontend**: https://ember-terminal-gamma.vercel.app (rename pending)
- **Backend**: https://ember-backend-q4nf.onrender.com (rename pending)
- **WebSocket**: wss://ember-backend-q4nf.onrender.com/ws

## Rules

1. **No simulated/fake data** — real API calls only
2. **Backend never signs** — every tx-building endpoint returns an unsigned tx message that the client (Phantom in PoC, Privy + paymaster in production) signs. The frontend `SignerProvider` interface is the swap point.
3. **Imperial is upstream** — the `metric-backend` is a thin proxy + WS fan-out + derived-data layer. Do not re-implement Imperial endpoints; call them.
4. **Run `tsc --noEmit` before committing** frontend changes
5. **Run `cargo clippy -- -D warnings` before committing** backend changes
6. **All testing must be automated** — no browser interaction, no human intervention required
