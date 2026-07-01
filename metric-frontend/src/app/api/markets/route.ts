/**
 * GET /api/markets — PUBLIC, read-only, no-JWT aggregated markets view.
 *
 * Thin server-side fan-out over Imperial's public read endpoints, folded into
 * one AI-friendly, symbol-keyed payload by `aggregateMarkets` (5-venue design:
 * flash_v2 | flash | phoenix | gmtrade | jupiter).
 *
 * Design rules (CLAUDE.md):
 *   - NO simulated/fake data: we only surface fields Imperial actually returns.
 *   - Imperial is upstream: we proxy + fold, we never re-implement it.
 *   - Best-effort: every upstream fetch is wrapped so a failure yields `null`
 *     rather than throwing. If EVERY upstream fails we still return a valid,
 *     mostly-empty payload at HTTP 200 (never 500) with a `note` field.
 *
 * Query params:
 *   - `venue`  (optional) — restrict to one venue (aliases handled downstream).
 *   - `period` (default "24h") — echoed through + passed to /stats/markets.
 */

import { API_V1, IMPERIAL_API_URL } from "@/lib/imperial/config";
import {
  aggregateMarkets,
  type AggregateInputs,
  type FlashMarket,
  type FlashV2Market,
  type FundingRates,
  type GmtradeLiquidity,
  type GmtradeMarket,
  type MarkPrices,
  type PhoenixMarket,
  type StatsMarkets,
  type StatsSummary,
} from "@/lib/imperial/markets-aggregate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-request upstream timeout (ms). */
const UPSTREAM_TIMEOUT_MS = 8000;

/** CORS + caching headers shared by GET + OPTIONS. */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

/**
 * Best-effort JSON fetch. NEVER throws: any network error, timeout, non-2xx,
 * or JSON-parse failure resolves to `null` so one bad upstream can't sink the
 * whole aggregate.
 */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${IMPERIAL_API_URL}${API_V1}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const venue = searchParams.get("venue") ?? undefined;
  const period = searchParams.get("period") ?? "24h";

  const periodQuery = encodeURIComponent(period);

  // Fetch ALL Imperial read endpoints in parallel; each resolves to null on
  // failure (getJson swallows errors). Order matches AggregateInputs shape.
  const [
    statsSummary,
    statsMarkets,
    markPrices,
    fundingRates,
    flashV2Markets,
    flashMarkets,
    phoenixMarkets,
    gmtradeMarkets,
    gmtradeLiquidity,
  ] = await Promise.all([
    getJson<StatsSummary>("/stats/summary"),
    getJson<StatsMarkets>(`/stats/markets?period=${periodQuery}`),
    getJson<MarkPrices>("/mark-prices"),
    getJson<FundingRates>("/funding-rates"),
    getJson<FlashV2Market[]>("/flash-v2/markets"),
    getJson<FlashMarket[]>("/flash/markets"),
    getJson<PhoenixMarket[]>("/phoenix/markets"),
    getJson<GmtradeMarket[]>("/gmtrade/markets"),
    getJson<GmtradeLiquidity[]>("/gmtrade/liquidity"),
  ]);

  const inputs: AggregateInputs = {
    statsSummary,
    statsMarkets,
    markPrices,
    fundingRates,
    flashV2Markets,
    flashMarkets,
    phoenixMarkets,
    gmtradeMarkets,
    gmtradeLiquidity,
  };

  const aggregated = aggregateMarkets(inputs, { venue, period });

  // If EVERY upstream failed, still return a valid mostly-empty payload at 200
  // with a `note` (never surface a 500 for a transient upstream outage).
  const everyUpstreamFailed =
    statsSummary === null &&
    statsMarkets === null &&
    markPrices === null &&
    fundingRates === null &&
    flashV2Markets === null &&
    flashMarkets === null &&
    phoenixMarkets === null &&
    gmtradeMarkets === null &&
    gmtradeLiquidity === null;

  const payload = everyUpstreamFailed
    ? {
        ...aggregated,
        note: "All upstream Imperial reads failed or timed out; returning an empty aggregate.",
      }
    : aggregated;

  return Response.json(payload, {
    headers: {
      ...CORS_HEADERS,
      "cache-control": "public, s-maxage=15, stale-while-revalidate=60",
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
