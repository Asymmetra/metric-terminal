# metric-frontend

Next.js frontend for **Metric Terminal** — a perpetuals trading terminal built on
[Imperial](https://api.imperial.space/api/v1/openapi.json) (Phoenix / Jupiter / Flash /
GMTrade, isolated-margin).

**See the [root README](../README.md)** for the full picture: architecture, the
Imperial integration notes (auth, the venue-specific `marketPrice` scale, routing, the
one-signature deposit→open / close→withdraw flow), environment variables, the live test
suite, and deployment.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional — public defaults work out of the box
npm run dev                  # http://localhost:3000 → /terminal
```

```bash
npx tsc --noEmit             # typecheck
npm test                     # Vitest unit tests
npm run build                # production build
```

Reference implementations to read first: `src/lib/imperial/` (client + types + JWT),
`src/lib/order-builder.ts` (scales, incl. `toMarketPrice`), and `src/lib/trade-flow.ts`
(the deposit→open / close→withdraw orchestration).
