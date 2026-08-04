/**
 * GET /api/pairs — PUBLIC, READ-ONLY, no-JWT aggregated Imperial "Pairs"
 * (underwriter 5) markets view.
 *
 * Thin server-side fan-out over Imperial's public read endpoints, folded into
 * one AI-friendly, symbol-keyed payload by `aggregatePairs`. It joins
 * GET /pairs/markets (two rows per symbol: long+short) with the optional per-symbol
 * `pairs` slice of GET /funding-rates.
 *
 * READ-ONLY: this surfaces pairs markets for AI consumption ONLY. There is NO
 * pairs trading/order path here — the underwriter-5 order contract is
 * undocumented and out of scope.
 *
 * Design rules (CLAUDE.md):
 *   - NO simulated/fake data: we only surface fields Imperial actually returns.
 *   - Imperial is upstream: we proxy + fold, we never re-implement it.
 *   - Best-effort: every upstream fetch is wrapped so a failure yields `null`
 *     rather than throwing. If EVERY upstream fails we still return a valid,
 *     mostly-empty payload at HTTP 200 (never 500) with a `note` field.
 */

import { API_V1, IMPERIAL_API_URL } from "@/lib/imperial/config";
import {
  aggregatePairs,
  type PairsAggregateInputs,
  type PairsFundingRates,
} from "@/lib/imperial/pairs-aggregate";
import type { PairsMarketRow } from "@/lib/imperial/types";

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

export async function GET(): Promise<Response> {
  // Fetch both Imperial read endpoints in parallel; each resolves to null on
  // failure (getJson swallows errors). Order matches PairsAggregateInputs shape.
  const [pairsMarkets, fundingRates] = await Promise.all([
    getJson<PairsMarketRow[]>("/pairs/markets"),
    getJson<PairsFundingRates>("/funding-rates"),
  ]);

  const inputs: PairsAggregateInputs = { pairsMarkets, fundingRates };

  const aggregated = aggregatePairs(inputs);

  // If EVERY upstream failed, still return a valid mostly-empty payload at 200
  // with a `note` (never surface a 500 for a transient upstream outage).
  const everyUpstreamFailed = pairsMarkets === null && fundingRates === null;

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
