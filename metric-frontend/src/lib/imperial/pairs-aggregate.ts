/**
 * Pure, unit-testable Imperial "Pairs" (underwriter 5) markets aggregation.
 *
 * Folds Imperial's read-only, no-JWT GET /pairs/markets (which returns TWO rows
 * per symbol — one `long`, one `short`) into one AI-friendly, symbol-keyed view,
 * optionally joining the per-symbol `pairs` funding slice from GET /funding-rates.
 *
 * READ-ONLY: this backs the read-only /api/pairs surface only. The underwriter-5
 * order contract is undocumented and out of scope — there is NO pairs order path.
 *
 * All inputs are nullable: either Imperial call may fail, so we NEVER throw and
 * gracefully omit whatever is missing.
 *
 * NO SIMULATED/FAKE DATA: we surface ONLY fields Imperial actually returns. The
 * long/short rows carry identical leverage/fee/liquidity per symbol, so we fold
 * them into a single object (OR-ing per-side `allowOpenPosition` into
 * `allowOpen.{long,short}`) — we never fabricate a rate, leverage, or liquidity.
 */

import type { PairsMarketRow } from "./types";

// ───────────────────────────────────── raw funding-rates input (pairs slice)
// GET /funding-rates rows MAY carry an optional `pairs` venue key (source
// "pairs_onchain_funding") alongside the other venues. We only read `pairs` here
// (mirrors the FundingRateVenue shape). Verified live 2026-08-03.

/** One venue's funding/borrow slice inside a GET /funding-rates row. Fields nullable. */
export interface PairsFundingVenue {
  source: string;
  longFundingRatePerHourPercent: number | null;
  shortFundingRatePerHourPercent: number | null;
  longBorrowRatePerHourPercent: number | null;
  shortBorrowRatePerHourPercent: number | null;
}
/**
 * One row of GET /funding-rates, as far as the pairs aggregate cares: the `pairs`
 * venue key is OPTIONAL/absent per symbol. Other venue keys may be present too
 * but are ignored here.
 */
export interface PairsFundingRatesRow {
  symbol: string;
  pairs?: PairsFundingVenue;
}
/** GET /funding-rates — funding + borrow rates per symbol per venue. */
export interface PairsFundingRates {
  rows: PairsFundingRatesRow[];
}

// ───────────────────────────────────── aggregate output shapes

/** Directional pair (funding or borrow) — numbers-or-null, as Imperial returns. */
export interface DirectionalRates {
  long: number | null;
  short: number | null;
}

/** Per-side open-position availability (OR-ed across the long/short rows). */
export interface PairsAllowOpen {
  long: boolean;
  short: boolean;
}

/** funding + borrow slice joined from funding-rates.pairs. Present only when non-null. */
export interface PairsFunding {
  funding?: DirectionalRates;
  borrow?: DirectionalRates;
}

/** One aggregated pairs market, folded from the symbol's long+short rows. */
export interface AggregatedPairsMarket {
  symbol: string;
  kind: "pair_geometric" | "single_feed";
  marketId: number;
  maxLeverage: number;
  maxOpenableLeverage: number;
  availableLiquidityUsd: number;
  feeRate: { openPosition: number; closePosition: number; impact: number };
  allowOpen: PairsAllowOpen;
  /** Joined from funding-rates.pairs when present. Omitted otherwise. */
  funding?: PairsFunding;
}

/** The full aggregated, AI-friendly pairs output. */
export interface AggregatedPairs {
  asOf: string;
  source: string;
  /** Number of markets in `markets`. */
  count: number;
  markets: AggregatedPairsMarket[];
}

/** Raw Imperial inputs — either may be `null` if that Imperial call failed. */
export interface PairsAggregateInputs {
  pairsMarkets: PairsMarketRow[] | null;
  fundingRates: PairsFundingRates | null;
}

/** Aggregation options. */
export interface PairsAggregateOptions {
  /** ISO timestamp to stamp on the output. Defaults to a deterministic epoch. */
  asOf?: string;
}

// ────────────────────────────────────────────────── helpers

/** UPPERCASE, trimmed symbol key, or `null` if empty. */
function symKey(symbol: string | null | undefined): string | null {
  if (symbol == null) return null;
  const s = String(symbol).trim().toUpperCase();
  return s.length > 0 ? s : null;
}

/** A funding/borrow pair is only emitted if at least one side is non-null. */
function directional(
  long: number | null | undefined,
  short: number | null | undefined,
): DirectionalRates | undefined {
  const l = long == null ? null : long;
  const s = short == null ? null : short;
  if (l === null && s === null) return undefined;
  return { long: l, short: s };
}

/** Defensive array coercion against malformed inputs. */
function arr<T>(x: T[] | null | undefined): T[] {
  return Array.isArray(x) ? x : [];
}

// ────────────────────────────────────────────── main entry

/**
 * Fold raw Imperial pairs responses into one symbol-keyed aggregate.
 *
 * PURE and NEVER throws: any input may be `null`/malformed and is skipped
 * gracefully. The emitted `asOf` comes from `opts.asOf` (or a deterministic
 * epoch fallback) — no ambient clock, so this stays testable.
 *
 * The long/short rows per symbol carry identical leverage/fee/liquidity, so we
 * fold them into one object; `allowOpen.{long,short}` is taken per-side from the
 * matching row. Markets are keyed by UPPERCASE symbol and sorted by
 * `availableLiquidityUsd` descending (ties broken alphabetically).
 *
 * @param inputs Raw Imperial responses (each nullable).
 * @param opts   Optional asOf stamp.
 */
export function aggregatePairs(
  inputs: Partial<PairsAggregateInputs> | null | undefined,
  opts?: PairsAggregateOptions | null,
): AggregatedPairs {
  const safe: PairsAggregateInputs = {
    pairsMarkets: inputs?.pairsMarkets ?? null,
    fundingRates: inputs?.fundingRates ?? null,
  };

  const asOf = opts?.asOf ? String(opts.asOf) : new Date(0).toISOString();

  // ── index the per-symbol pairs funding slice ──
  const fundingBySym = new Map<string, PairsFundingVenue>();
  for (const row of arr(safe.fundingRates?.rows)) {
    const k = symKey(row?.symbol);
    if (!k) continue;
    const p = row?.pairs;
    if (p && !fundingBySym.has(k)) fundingBySym.set(k, p);
  }

  // ── fold the long/short rows per symbol ──
  // First matching row seeds the shared fields (identical across the pair); each
  // row's `allowOpenPosition` fills its own side of `allowOpen`.
  const bySym = new Map<string, AggregatedPairsMarket>();
  for (const m of arr(safe.pairsMarkets)) {
    const k = symKey(m?.symbol);
    if (!k) continue;
    let agg = bySym.get(k);
    if (!agg) {
      agg = {
        symbol: k,
        kind: m.kind === "single_feed" ? "single_feed" : "pair_geometric",
        marketId: typeof m.marketId === "number" ? m.marketId : 0,
        maxLeverage: typeof m.maxLeverage === "number" ? m.maxLeverage : 0,
        maxOpenableLeverage:
          typeof m.maxOpenableLeverage === "number" ? m.maxOpenableLeverage : 0,
        availableLiquidityUsd:
          typeof m.availableLiquidityUsd === "number" ? m.availableLiquidityUsd : 0,
        feeRate: {
          openPosition: typeof m.openPositionFeeRate === "number" ? m.openPositionFeeRate : 0,
          closePosition: typeof m.closePositionFeeRate === "number" ? m.closePositionFeeRate : 0,
          impact: typeof m.impactFeeRate === "number" ? m.impactFeeRate : 0,
        },
        allowOpen: { long: false, short: false },
      };
      bySym.set(k, agg);
    }
    if (m.side === "long" && m.allowOpenPosition === true) agg.allowOpen.long = true;
    if (m.side === "short" && m.allowOpenPosition === true) agg.allowOpen.short = true;
  }

  // ── join funding-rates.pairs where present ──
  for (const [k, agg] of bySym) {
    const p = fundingBySym.get(k);
    if (!p) continue;
    const funding = directional(
      p.longFundingRatePerHourPercent,
      p.shortFundingRatePerHourPercent,
    );
    const borrow = directional(
      p.longBorrowRatePerHourPercent,
      p.shortBorrowRatePerHourPercent,
    );
    if (funding || borrow) {
      const f: PairsFunding = {};
      if (funding) f.funding = funding;
      if (borrow) f.borrow = borrow;
      agg.funding = f;
    }
  }

  const markets = Array.from(bySym.values());

  // Stable ordering: highest available liquidity first, then alpha by symbol.
  markets.sort((a, b) => {
    const av = Number(a.availableLiquidityUsd);
    const bv = Number(b.availableLiquidityUsd);
    const an = Number.isFinite(av) ? av : 0;
    const bn = Number.isFinite(bv) ? bv : 0;
    if (bn !== an) return bn - an;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });

  return {
    asOf,
    source: sourceLabel(safe),
    count: markets.length,
    markets,
  };
}

/** Human-readable label of which Imperial reads actually contributed. */
function sourceLabel(inputs: PairsAggregateInputs): string {
  const parts: string[] = [];
  if (inputs.pairsMarkets) parts.push("pairs/markets");
  if (inputs.fundingRates) parts.push("funding-rates");
  return parts.length ? `imperial:${parts.join("+")}` : "imperial";
}
