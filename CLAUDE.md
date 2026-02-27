# Ember Terminal — Project Rules

## CRITICAL: No Worktrees

**Worktrees are DISABLED.** Do not create git worktrees, do not use `git worktree add`, do not use Pentagon worktree isolation. All agents work directly on the main repository:

- **Working directory**: `/Users/liamdig/Desktop/sandbox/ember-terminal`
- **Branch**: `main` (always)
- **No feature branches** — commit directly to main
- **No worktrees** — they have been removed and must not be recreated

If your tooling or workflow attempts to create a worktree, override it. Work in-place on main.

## Repository Structure

- `ember-frontend/` — Next.js frontend (TypeScript, Tailwind)
- `ember-backend/` — Rust/Axum backend
- `phoenix-rise-sdk/` — **READ-ONLY** — Do not edit
- `phoenix-sdk-docs/` — **READ-ONLY** — Do not edit
- `.keys/test-wallet.json` — Test wallet keypair (pubkey: HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x)

## Production Endpoints

- **Frontend**: https://ember-terminal-six.vercel.app
- **Backend**: https://ember-backend-q4nf.onrender.com
- **WebSocket**: wss://ember-backend-q4nf.onrender.com/ws

## API Routes

All trade/transaction endpoints are under `/api/tx/`:
- `/api/tx/market-order`
- `/api/tx/limit-order`
- `/api/tx/cancel-orders`
- `/api/tx/deposit`
- `/api/tx/withdraw`
- `/api/tx/isolated-market-order`
- `/api/tx/isolated-limit-order`
- `/api/tx/transfer-collateral`
- `/api/tx/register-subaccount`

Data endpoints:
- `/api/markets`
- `/api/orderbook/{market}`
- `/api/candles/{market}`
- `/api/trader/{pubkey}`

## Rules

1. **No simulated/fake data** — real API calls only
2. **No editing SDK or docs** — `phoenix-rise-sdk/` and `phoenix-sdk-docs/` are read-only
3. **Run `tsc --noEmit` before committing** frontend changes
4. **Run `cargo clippy -- -D warnings` before committing** backend changes
5. **All testing must be automated** — no browser interaction, no human intervention required
