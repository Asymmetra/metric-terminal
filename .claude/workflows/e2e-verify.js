export const meta = {
  name: 'e2e-verify',
  description: 'Non-mutating e2e verification: static gates + live Imperial API contract + flash_v2 order/close correctness',
  whenToUse: 'Run before manual testing to confirm the whole stack is green end-to-end (no funds moved).',
  phases: [{ title: 'Verify' }],
}

const FE = '/Users/liamdig/Desktop/sandbox/Asymmetra/metric-terminal/metric-frontend'
const API = 'https://api.imperial.space/api/v1'

const RESULT_SCHEMA = {
  type: 'object',
  required: ['dimension', 'passed', 'checks', 'summary'],
  properties: {
    dimension: { type: 'string' },
    passed: { type: 'boolean', description: 'true only if every check passed' },
    summary: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'passed', 'detail'],
        properties: {
          name: { type: 'string' },
          passed: { type: 'boolean' },
          detail: { type: 'string', description: 'evidence: command output, counts, quoted code, or API values' },
        },
      },
    },
  },
}

const DIMENSIONS = [
  {
    key: 'static-tsc-vitest',
    prompt: `Run \`cd ${FE} && npx tsc --noEmit\` then \`cd ${FE} && npx vitest run\`. Report two checks: (1) tsc is clean (no errors); (2) ALL vitest tests pass — give the exact "Tests N passed" count and the file count. Fail the dimension if either errors.`,
  },
  {
    key: 'production-build',
    prompt: `Run \`cd ${FE} && npm run build\`. Report one check: the Next.js production build completes with no type/build error (quote the final "Compiled successfully" / route table or the error). Fail on any error.`,
  },
  {
    key: 'flash-v2-api-contract',
    prompt: `Using curl (read-only GETs), verify the live Imperial flash_v2 contract. Report each as a check with the actual values:
1. \`${API}/flash-v2/markets\` returns a non-empty array that includes a SOL market with a non-empty targetMint, allowOpenPosition true, and availableLiquidityUsd > 0.
2. \`${API}/route?asset=SOL&side=long&notional=100&desiredLeverage=2\` includes a candidate with venue "flash_v2" and filteredReason null.
3. \`${API}/mark-prices\` has a SOL row with a "flash" price object.
4. \`${API}/flash/markets\` lists ONLY underwriter "flash_trade" (i.e. it is the V1 endpoint; this is expected, not a bug).
Fail the dimension if 1, 2, or 3 fail (4 is a sanity check). Use python3 to parse JSON.`,
  },
  {
    key: 'order-payload-correctness',
    prompt: `Read ${FE}/src/lib/order-builder.ts and ${FE}/src/lib/imperial/types.ts. Statically confirm (quote the lines) that for venue "flash_v2", buildOrderRequest produces: (1) underwriter === Underwriter.FlashV2 === 4; (2) marketPrice computed at the 1e9 oracle scale (VENUE_CONFIG.flash_v2.marketPriceScale === PRICE_SCALE === 1e9, used by toMarketPrice); (3) the returned object contains \`symbol\` and does NOT contain a \`marketMint\` key (so Imperial's per-underwriter symbol resolver is used); (4) VENUE_CONFIG.flash_v2.markKey === "flash" (shared price feed). Report each as a check.`,
  },
  {
    key: 'close-path-and-hardening',
    prompt: `Read ${FE}/src/lib/position-mapping.ts and ${FE}/src/lib/trade-flow.ts. Confirm (quote lines): (1) venueOf maps a position whose underwriter/source contains "flash" AND "v2" to the VenueTag "flash_v2" (NOT "flash_trade"), so a v2 close uses underwriter 4; (2) venueOf maps bare "flash"/"flash_trade" (no v2) to "flash_trade"; (3) isTransientResolveError returns true for a "could not resolve symbol" / "venue lists this market" error and false for a hard rejection; (4) openWithDeposit retries the SAME venue once on a transient resolve miss before falling through. Report each as a check.`,
  },
]

phase('Verify')
const results = (await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `verify:${d.key}`, phase: 'Verify', schema: RESULT_SCHEMA })
)).filter(Boolean)

const failedChecks = results.flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => ({ dimension: r.dimension, ...c })))

return {
  allPassed: results.length === DIMENSIONS.length && results.every((r) => r.passed),
  dimensions: results.map((r) => ({ dimension: r.dimension, passed: r.passed, summary: r.summary })),
  failedChecks,
  fullChecks: results.flatMap((r) => r.checks.map((c) => ({ dimension: r.dimension, ...c }))),
}
