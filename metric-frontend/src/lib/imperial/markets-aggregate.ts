/**
 * Pure, unit-testable Imperial markets aggregation (5-venue).
 *
 * Folds Imperial's read-only, no-JWT endpoints into one AI-friendly,
 * symbol-keyed view. All inputs are nullable: ANY Imperial call may fail, so we
 * NEVER throw and gracefully omit whatever is missing.
 *
 * NO SIMULATED/FAKE DATA: we surface ONLY fields Imperial actually returns. We
 * never fabricate a mark price, leverage, funding rate, or volume.
 *
 * ── The five venues ──────────────────────────────────────────────────────
 *   flash_v2 | flash | phoenix | gmtrade | jupiter
 *
 * CRITICAL — `flash` and `flash_v2` are DISTINCT pools with SEPARATE market
 * endpoints:
 *   - `flash_v2` is the high-leverage pool (up to ~550x). Its ONLY data source
 *     is GET /flash-v2/markets (underwriter "flash_v2"), which exposes
 *     markets / maxLeverage / open+close fee rates / liquidity / max-position /
 *     availability. Imperial DOES NOT expose flash_v2's mark price, funding, or
 *     volume separately, so those are OMITTED for flash_v2. The `flash` keys in
 *     /mark-prices, /funding-rates, /stats/summary, and /stats/markets byVenue
 *     are the v1 pool ONLY and MUST NOT be attributed to flash_v2.
 *   - `flash` (v1, underwriter "flash_trade") is the original Flash pool
 *     (~117x for SOL). Data comes from GET /flash/markets (maxLeverage, open
 *     fee, volatility fee) plus mark-prices.flash, funding-rates.flash, and
 *     stats byVenue.flashUsd.
 *
 * `phoenix` and `gmtrade` have their own market lists plus mark/funding rows
 * (gmtrade also has /gmtrade/liquidity). `jupiter` appears ONLY in stats
 * (byVenue.jupiterUsd + /stats/summary): no markets/mark/funding rows, so its
 * per-market surface is limited to a volume share.
 */

// ────────────────────────────────────────────── venue keys

/** Canonical venue keys used throughout the aggregate output. */
export type VenueKey = "flash_v2" | "flash" | "phoenix" | "gmtrade" | "jupiter";

/** Canonical venue ordering for `venues[]`, `byVenue`, and per-market iteration. */
export const VENUE_ORDER: readonly VenueKey[] = [
  "flash_v2",
  "flash",
  "phoenix",
  "gmtrade",
  "jupiter",
] as const;

// ───────────────────────────────────── raw Imperial input shapes
// These mirror the REAL live shapes (verified 2026-07-01). Where a venue key is
// absent per row Imperial simply omits it — hence venue fields are optional.

/** One per-venue slice inside GET /stats/summary. NOTE: only a combined "flash". */
export interface StatsSummaryVenue {
  venue: "flash" | "gmtrade" | "jupiter" | "phoenix";
  volumeUsd: string;
  openInterestUsd: string;
  traderCount: number;
}
/** GET /stats/summary — protocol-wide headline figures. All *Usd are decimal STRINGS. */
export interface StatsSummary {
  asOf: string;
  volume24hUsd: string;
  volume7dUsd: string;
  volumeAllUsd: string;
  openInterestUsd: string;
  activeTraders24h: number;
  feeRevenue24hUsd: string;
  venues: StatsSummaryVenue[];
}

/** Per-venue volume split inside a GET /stats/markets row. NO flash_v2 key. */
export interface StatsMarketsByVenue {
  jupiterUsd: string;
  flashUsd: string;
  phoenixUsd: string;
  gmtradeUsd: string;
}
/** One row of GET /stats/markets. All *Usd are decimal STRINGS. */
export interface StatsMarketsRow {
  symbol: string;
  volumeUsd: string;
  openInterestUsd: string;
  longOiUsd: string;
  shortOiUsd: string;
  traderCount: number;
  positionCount: number;
  byVenue: StatsMarketsByVenue;
}
/** GET /stats/markets?period=… — per-market volume + OI breakdown. */
export interface StatsMarkets {
  period: string;
  rows: StatsMarketsRow[];
}

/** One venue's mark-price entry inside a GET /mark-prices row. */
export interface MarkPriceVenue {
  source: string;
  price: number;
  fetchedAtUnixMs: number;
}
/**
 * One row of GET /mark-prices. Venue keys are OPTIONAL/absent per symbol.
 * NO flash_v2 key and NO jupiter key — the `flash` key here is the v1 pool.
 */
export interface MarkPricesRow {
  symbol: string;
  flash?: MarkPriceVenue;
  phoenix?: MarkPriceVenue;
  gmtrade?: MarkPriceVenue;
}
/** GET /mark-prices — latest mark prices per symbol per venue. */
export interface MarkPrices {
  rows: MarkPricesRow[];
}

/** One venue's funding/borrow rates inside a GET /funding-rates row. Fields nullable. */
export interface FundingRateVenue {
  source: string;
  longFundingRatePerHourPercent: number | null;
  shortFundingRatePerHourPercent: number | null;
  longBorrowRatePerHourPercent: number | null;
  shortBorrowRatePerHourPercent: number | null;
}
/**
 * One row of GET /funding-rates. Venue keys OPTIONAL/absent per symbol.
 * NO flash_v2 key and NO jupiter key — the `flash` key here is the v1 pool.
 */
export interface FundingRatesRow {
  symbol: string;
  flash?: FundingRateVenue;
  phoenix?: FundingRateVenue;
  gmtrade?: FundingRateVenue;
}
/** GET /funding-rates — funding + borrow rates per symbol per venue. */
export interface FundingRates {
  rows: FundingRatesRow[];
}

/**
 * One entry of GET /flash-v2/markets (UNDOCUMENTED but live, 200).
 * Imperial returns TWO entries per symbol (one `long`, one `short`).
 * This is the high-leverage pool (maxLeverage up to ~550x for SOL/BTC/ETH).
 * `underwriter` is "flash_v2" -> normalized to venue key "flash_v2".
 */
export interface FlashV2Market {
  symbol: string;
  side: "long" | "short";
  underwriter: "flash_v2";
  marketAddress: string;
  targetMint: string;
  maxLeverage: number;
  openPositionFeeRate: number;
  closePositionFeeRate: number | null;
  availableLiquidityUsd: number | null;
  maxPositionSizeUsd: number | null;
  allowOpenPosition: boolean;
  pythLazerSymbol: string;
  schedule: unknown;
  // Additional fields Imperial returns are permitted but not consumed here.
  [key: string]: unknown;
}

/**
 * One entry of GET /flash/markets (Flash v1). Imperial returns TWO entries per
 * symbol (one `long`, one `short`); leverage/fees are identical across the pair.
 * `underwriter` is "flash_trade" -> normalized to venue key "flash".
 */
export interface FlashMarket {
  symbol: string;
  side: "long" | "short";
  underwriter: "flash_trade";
  maxLeverage: number;
  openPositionFeeRate: number;
  volatilityFeeRate: number;
  maxConfBps: number;
  allowOpenPosition: boolean;
  allowClosePosition: boolean;
  tokenDecimals: number;
  poolName: string;
  // Additional fields Imperial returns are permitted but not consumed here.
  [key: string]: unknown;
}

/** One entry of GET /phoenix/markets (one per symbol). */
export interface PhoenixMarket {
  symbol: string;
  underwriter: "phoenix";
  maxLeverage: number;
  makerFeeMicro: number;
  takerFeeMicro: number;
  [key: string]: unknown;
}

/** One entry of GET /gmtrade/markets (one per symbol). NOTE: NO maxLeverage field. */
export interface GmtradeMarket {
  symbol: string;
  underwriter: "gmtrade";
  market: string;
  oracle: string;
  indexTokenDecimals: number;
  closed: boolean;
  [key: string]: unknown;
}

/** One entry of GET /gmtrade/liquidity. */
export interface GmtradeLiquidity {
  symbol: string;
  longAvailableUsd: number | null;
  shortAvailableUsd: number | null;
}

// ───────────────────────────────────── aggregate output shapes

/** Directional pair (funding or borrow) — numbers-or-null, as Imperial returns. */
export interface DirectionalRates {
  long: number | null;
  short: number | null;
}

/**
 * flash_v2 per-market view. Includes ONLY fields the v2 pool provides.
 * NO markPrice / funding / volumeUsd — Imperial does not expose those for v2.
 */
export interface FlashV2VenueMarket {
  available: boolean;
  maxLeverage: number;
  feeRate: { openPosition: number; closePosition?: number };
  availableLiquidityUsd?: number;
  maxPositionSizeUsd?: number;
}

/** flash (v1) per-market view. Includes ONLY fields the v1 pool provides. */
export interface FlashVenueMarket {
  available: boolean;
  /** Omitted when the venue is present only via mark/funding/volume (market list unavailable). */
  maxLeverage?: number;
  feeRate?: { openPosition: number; volatility: number };
  markPrice?: number;
  funding?: DirectionalRates;
  borrow?: DirectionalRates;
  volumeUsd?: string;
}

/** phoenix per-market view. */
export interface PhoenixVenueMarket {
  available: boolean;
  /** Omitted when the venue is present only via mark/funding/volume (market list unavailable). */
  maxLeverage?: number;
  markPrice?: number;
  funding?: DirectionalRates;
  feeRate?: { makerMicro: number; takerMicro: number };
  volumeUsd?: string;
}

/** gmtrade per-market view. NO maxLeverage — gmtrade exposes none. */
export interface GmtradeVenueMarket {
  available: boolean;
  markPrice?: number;
  funding?: DirectionalRates;
  borrow?: DirectionalRates;
  liquidity?: { longAvailableUsd: number | null; shortAvailableUsd: number | null };
  closed?: boolean;
  volumeUsd?: string;
}

/** jupiter per-market view — limited to a volume share (stats only). */
export interface JupiterVenueMarket {
  available: boolean;
  volumeUsd?: string;
}

/** A symbol's per-venue market views, keyed by canonical venue. Present keys only. */
export interface MarketVenues {
  flash_v2?: FlashV2VenueMarket;
  flash?: FlashVenueMarket;
  phoenix?: PhoenixVenueMarket;
  gmtrade?: GmtradeVenueMarket;
  jupiter?: JupiterVenueMarket;
}

/** One aggregated market, keyed by UPPERCASE symbol. */
export interface AggregatedMarket {
  symbol: string;
  volumeUsd: string;
  openInterestUsd: string;
  longOiUsd: string;
  shortOiUsd: string;
  traderCount: number;
  positionCount: number;
  venues: MarketVenues;
}

/** Per-venue protocol-wide totals slice. */
export interface AggregatedVenueTotals {
  volumeUsd: string;
  openInterestUsd: string;
  traderCount: number;
}

/** Protocol-wide totals. */
export interface AggregatedTotals {
  volume24hUsd: string;
  volume7dUsd: string;
  volumeAllUsd: string;
  openInterestUsd: string;
  activeTraders24h: number;
  feeRevenue24hUsd: string;
  byVenue: Record<string, AggregatedVenueTotals>;
}

/** The full aggregated, AI-friendly output. */
export interface AggregatedMarkets {
  asOf: string;
  source: string;
  period: string;
  /** The venue filter that was applied (normalized), or null when ALL venues are returned. */
  filter: string | null;
  /** Number of markets in `markets` (after any venue filter). */
  count: number;
  venues: string[];
  totals: AggregatedTotals;
  markets: AggregatedMarket[];
}

/** Raw Imperial inputs — any may be `null` if that Imperial call failed. */
export interface AggregateInputs {
  statsSummary: StatsSummary | null;
  statsMarkets: StatsMarkets | null;
  markPrices: MarkPrices | null;
  fundingRates: FundingRates | null;
  flashV2Markets: FlashV2Market[] | null;
  flashMarkets: FlashMarket[] | null;
  phoenixMarkets: PhoenixMarket[] | null;
  gmtradeMarkets: GmtradeMarket[] | null;
  gmtradeLiquidity: GmtradeLiquidity[] | null;
}

/** Aggregation options. */
export interface AggregateOptions {
  /**
   * Restrict output to a single venue (case-insensitive, with aliases):
   *   flash_v2 | flashv2 | flash-v2 | v2      -> flash_v2
   *   flash | flash_trade | flashtrade | v1   -> flash
   *   phoenix
   *   gmtrade | gm                            -> gmtrade
   *   jupiter | jup                           -> jupiter
   * When set, `venues[]`, `totals.byVenue`, and each `market.venues` are
   * restricted to that venue, and markets where it is unavailable are DROPPED.
   * Unset -> all venues.
   */
  venue?: string;
  /** Period label to echo in the output (e.g. "24h"). */
  period?: string;
}

// ────────────────────────────────────────────────── helpers

/** Normalize a raw underwriter tag to a canonical venue key, or `null`. */
export function normalizeUnderwriter(underwriter: string | null | undefined): VenueKey | null {
  if (underwriter == null) return null;
  switch (String(underwriter).trim().toLowerCase()) {
    case "flash_v2":
      return "flash_v2";
    case "flash_trade":
    case "flash":
      return "flash";
    case "phoenix":
      return "phoenix";
    case "gmtrade":
      return "gmtrade";
    case "jupiter":
      return "jupiter";
    default:
      return null;
  }
}

/**
 * Resolve `opts.venue` (case-insensitive, with aliases) to a canonical venue
 * key, `null` when unset/blank (no filter), or `undefined` when it matches no
 * known venue (caller treats that as "restrict to nothing").
 */
export function resolveVenueFilter(venue: string | null | undefined): VenueKey | null | undefined {
  if (venue == null) return null;
  const v = String(venue).trim().toLowerCase();
  if (v === "") return null;
  switch (v) {
    case "flash_v2":
    case "flashv2":
    case "flash-v2":
    case "v2":
      return "flash_v2";
    case "flash":
    case "flash_trade":
    case "flashtrade":
    case "flash-trade":
    case "v1":
      return "flash";
    case "phoenix":
      return "phoenix";
    case "gmtrade":
    case "gm":
      return "gmtrade";
    case "jupiter":
    case "jup":
      return "jupiter";
    default:
      return undefined;
  }
}

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

/** Map a canonical venue key to its `byVenue.<x>Usd` field. flash_v2 has NONE. */
function byVenueVolume(
  byVenue: StatsMarketsByVenue | null | undefined,
  venue: VenueKey,
): string | undefined {
  if (byVenue == null) return undefined;
  switch (venue) {
    case "flash":
      return typeof byVenue.flashUsd === "string" ? byVenue.flashUsd : undefined;
    case "phoenix":
      return typeof byVenue.phoenixUsd === "string" ? byVenue.phoenixUsd : undefined;
    case "gmtrade":
      return typeof byVenue.gmtradeUsd === "string" ? byVenue.gmtradeUsd : undefined;
    case "jupiter":
      return typeof byVenue.jupiterUsd === "string" ? byVenue.jupiterUsd : undefined;
    case "flash_v2":
      return undefined; // Imperial exposes NO flash_v2 volume share.
  }
}

/** Defensive array coercion against malformed inputs. */
function arr<T>(x: T[] | null | undefined): T[] {
  return Array.isArray(x) ? x : [];
}

// ────────────────────────────────────────────── main entry

/**
 * Fold raw Imperial read responses into one symbol-keyed aggregate.
 *
 * PURE and NEVER throws: any input may be `null`/malformed and is skipped
 * gracefully. The emitted `asOf` comes from `statsSummary.asOf` (or a
 * deterministic epoch fallback) — no ambient clock, so this stays testable.
 *
 * @param inputs Raw Imperial responses (each nullable).
 * @param opts   Optional venue filter + period label.
 */
export function aggregateMarkets(
  inputs: Partial<AggregateInputs> | null | undefined,
  opts?: AggregateOptions | null,
): AggregatedMarkets {
  const safe: AggregateInputs = {
    statsSummary: inputs?.statsSummary ?? null,
    statsMarkets: inputs?.statsMarkets ?? null,
    markPrices: inputs?.markPrices ?? null,
    fundingRates: inputs?.fundingRates ?? null,
    flashV2Markets: inputs?.flashV2Markets ?? null,
    flashMarkets: inputs?.flashMarkets ?? null,
    phoenixMarkets: inputs?.phoenixMarkets ?? null,
    gmtradeMarkets: inputs?.gmtradeMarkets ?? null,
    gmtradeLiquidity: inputs?.gmtradeLiquidity ?? null,
  };

  // `null` => no filter; `undefined` => unknown venue => restrict to nothing.
  const venueFilter = resolveVenueFilter(opts?.venue);
  const venueAllowed = (v: VenueKey): boolean => {
    if (venueFilter === null) return true;
    if (venueFilter === undefined) return false;
    return v === venueFilter;
  };

  // ── period + asOf resolution (prefer explicit opts, then Imperial data) ──
  const period =
    (opts?.period && String(opts.period)) ||
    (safe.statsMarkets?.period ? String(safe.statsMarkets.period) : "") ||
    "";
  const asOf = safe.statsSummary?.asOf
    ? String(safe.statsSummary.asOf)
    : new Date(0).toISOString(); // deterministic fallback; never fabricate "now"

  // ── index the per-symbol raw data ──
  const statsRows = new Map<string, StatsMarketsRow>();
  for (const row of arr(safe.statsMarkets?.rows)) {
    const k = symKey(row?.symbol);
    if (k) statsRows.set(k, row);
  }

  const markRows = new Map<string, MarkPricesRow>();
  for (const row of arr(safe.markPrices?.rows)) {
    const k = symKey(row?.symbol);
    if (k) markRows.set(k, row);
  }

  const fundingRows = new Map<string, FundingRatesRow>();
  for (const row of arr(safe.fundingRates?.rows)) {
    const k = symKey(row?.symbol);
    if (k) fundingRows.set(k, row);
  }

  // flash_v2: dedupe long/short into one per-symbol entry. Keep max leverage
  // and OR availability across sides; carry the richest fee/liquidity fields.
  const flashV2BySym = new Map<string, FlashV2Market[]>();
  for (const m of arr(safe.flashV2Markets)) {
    if (normalizeUnderwriter(m?.underwriter) !== "flash_v2") continue;
    const k = symKey(m?.symbol);
    if (!k) continue;
    const list = flashV2BySym.get(k);
    if (list) list.push(m);
    else flashV2BySym.set(k, [m]);
  }

  // flash (v1): dedupe long/short (leverage/fees identical across the pair).
  const flashBySym = new Map<string, FlashMarket[]>();
  for (const m of arr(safe.flashMarkets)) {
    if (normalizeUnderwriter(m?.underwriter) !== "flash") continue;
    const k = symKey(m?.symbol);
    if (!k) continue;
    const list = flashBySym.get(k);
    if (list) list.push(m);
    else flashBySym.set(k, [m]);
  }

  const phoenixBySym = new Map<string, PhoenixMarket>();
  for (const m of arr(safe.phoenixMarkets)) {
    const k = symKey(m?.symbol);
    if (k && !phoenixBySym.has(k)) phoenixBySym.set(k, m);
  }

  const gmtradeBySym = new Map<string, GmtradeMarket>();
  for (const m of arr(safe.gmtradeMarkets)) {
    const k = symKey(m?.symbol);
    if (k && !gmtradeBySym.has(k)) gmtradeBySym.set(k, m);
  }

  const gmLiquidityBySym = new Map<string, GmtradeLiquidity>();
  for (const l of arr(safe.gmtradeLiquidity)) {
    const k = symKey(l?.symbol);
    if (k && !gmLiquidityBySym.has(k)) gmLiquidityBySym.set(k, l);
  }

  // ── symbol universe = union across stats + ALL venue markets + mark/funding ──
  const symbols = new Set<string>();
  for (const k of statsRows.keys()) symbols.add(k);
  for (const k of markRows.keys()) symbols.add(k);
  for (const k of fundingRows.keys()) symbols.add(k);
  for (const k of flashV2BySym.keys()) symbols.add(k);
  for (const k of flashBySym.keys()) symbols.add(k);
  for (const k of phoenixBySym.keys()) symbols.add(k);
  for (const k of gmtradeBySym.keys()) symbols.add(k);

  // Which venues are actually present across all markets (drives venues[]).
  const presentVenues = new Set<VenueKey>();

  const markets: AggregatedMarket[] = [];

  for (const symbol of symbols) {
    const stats = statsRows.get(symbol) ?? null;
    const mark = markRows.get(symbol) ?? null;
    const funding = fundingRows.get(symbol) ?? null;

    const venues: MarketVenues = {};

    // ── flash_v2 (markets/leverage/liquidity ONLY; no mark/funding/volume) ──
    if (venueAllowed("flash_v2")) {
      const sides = flashV2BySym.get(symbol);
      if (sides && sides.length > 0) {
        let maxLeverage = 0;
        let available = false;
        let openPosition = 0;
        let closePosition: number | undefined;
        let availableLiquidityUsd: number | undefined;
        let maxPositionSizeUsd: number | undefined;
        for (const s of sides) {
          if (typeof s.maxLeverage === "number") maxLeverage = Math.max(maxLeverage, s.maxLeverage);
          if (s.allowOpenPosition === true) available = true;
          if (typeof s.openPositionFeeRate === "number") openPosition = s.openPositionFeeRate;
          if (typeof s.closePositionFeeRate === "number") closePosition = s.closePositionFeeRate;
          if (typeof s.availableLiquidityUsd === "number") {
            availableLiquidityUsd = Math.max(availableLiquidityUsd ?? 0, s.availableLiquidityUsd);
          }
          if (typeof s.maxPositionSizeUsd === "number") {
            maxPositionSizeUsd = Math.max(maxPositionSizeUsd ?? 0, s.maxPositionSizeUsd);
          }
        }
        const vm: FlashV2VenueMarket = {
          available,
          maxLeverage,
          feeRate: { openPosition },
        };
        if (closePosition !== undefined) vm.feeRate.closePosition = closePosition;
        if (availableLiquidityUsd !== undefined) vm.availableLiquidityUsd = availableLiquidityUsd;
        if (maxPositionSizeUsd !== undefined) vm.maxPositionSizeUsd = maxPositionSizeUsd;
        venues.flash_v2 = vm;
        presentVenues.add("flash_v2");
      }
    }

    // ── flash (v1) ──
    if (venueAllowed("flash")) {
      const sides = flashBySym.get(symbol);
      const flashMkt = sides && sides.length > 0 ? sides[0] : null;
      const flashMark = mark?.flash;
      const flashFund = funding?.flash;
      const flashVol = byVenueVolume(stats?.byVenue, "flash");
      const hasFlash =
        flashMkt != null ||
        flashMark != null ||
        flashFund != null ||
        (typeof flashVol === "string" && flashVol.length > 0);
      if (hasFlash) {
        let maxLeverage = 0;
        let available = false;
        let openPosition = 0;
        let volatility = 0;
        for (const s of sides ?? []) {
          if (typeof s.maxLeverage === "number") maxLeverage = Math.max(maxLeverage, s.maxLeverage);
          if (s.allowOpenPosition === true) available = true;
          if (typeof s.openPositionFeeRate === "number") openPosition = s.openPositionFeeRate;
          if (typeof s.volatilityFeeRate === "number") volatility = s.volatilityFeeRate;
        }
        // Available if the market allows opening OR any live mark/funding/volume.
        if (flashMark != null || flashFund != null || (typeof flashVol === "string" && flashVol.length > 0)) {
          available = true;
        }
        const vm: FlashVenueMarket = { available };
        // Only surface leverage/fees when they actually came from the market list —
        // never a misleading 0 placeholder for a venue seen only via mark/funding.
        if (flashMkt != null) {
          vm.maxLeverage = maxLeverage;
          vm.feeRate = { openPosition, volatility };
        }
        if (flashMark && typeof flashMark.price === "number") vm.markPrice = flashMark.price;
        if (flashFund) {
          const f = directional(flashFund.longFundingRatePerHourPercent, flashFund.shortFundingRatePerHourPercent);
          if (f) vm.funding = f;
          const b = directional(flashFund.longBorrowRatePerHourPercent, flashFund.shortBorrowRatePerHourPercent);
          if (b) vm.borrow = b;
        }
        if (typeof flashVol === "string") vm.volumeUsd = flashVol;
        venues.flash = vm;
        presentVenues.add("flash");
      }
    }

    // ── phoenix ──
    if (venueAllowed("phoenix")) {
      const phxMkt = phoenixBySym.get(symbol) ?? null;
      const phxMark = mark?.phoenix;
      const phxFund = funding?.phoenix;
      const phxVol = byVenueVolume(stats?.byVenue, "phoenix");
      const hasPhoenix =
        phxMkt != null ||
        phxMark != null ||
        phxFund != null ||
        (typeof phxVol === "string" && phxVol.length > 0);
      if (hasPhoenix) {
        const vm: PhoenixVenueMarket = { available: true };
        // Leverage/fees only when the market list supplied them (no 0 placeholder).
        if (phxMkt != null) {
          if (typeof phxMkt.maxLeverage === "number") vm.maxLeverage = phxMkt.maxLeverage;
          vm.feeRate = {
            makerMicro: typeof phxMkt.makerFeeMicro === "number" ? phxMkt.makerFeeMicro : 0,
            takerMicro: typeof phxMkt.takerFeeMicro === "number" ? phxMkt.takerFeeMicro : 0,
          };
        }
        if (phxMark && typeof phxMark.price === "number") vm.markPrice = phxMark.price;
        if (phxFund) {
          const f = directional(phxFund.longFundingRatePerHourPercent, phxFund.shortFundingRatePerHourPercent);
          if (f) vm.funding = f;
        }
        if (typeof phxVol === "string") vm.volumeUsd = phxVol;
        venues.phoenix = vm;
        presentVenues.add("phoenix");
      }
    }

    // ── gmtrade (no maxLeverage) ──
    if (venueAllowed("gmtrade")) {
      const gmMkt = gmtradeBySym.get(symbol) ?? null;
      const gmMark = mark?.gmtrade;
      const gmFund = funding?.gmtrade;
      const gmVol = byVenueVolume(stats?.byVenue, "gmtrade");
      const gmLiq = gmLiquidityBySym.get(symbol) ?? null;
      const hasGmtrade =
        gmMkt != null ||
        gmMark != null ||
        gmFund != null ||
        (typeof gmVol === "string" && gmVol.length > 0);
      if (hasGmtrade) {
        const vm: GmtradeVenueMarket = { available: true };
        if (gmMark && typeof gmMark.price === "number") vm.markPrice = gmMark.price;
        if (gmFund) {
          const f = directional(gmFund.longFundingRatePerHourPercent, gmFund.shortFundingRatePerHourPercent);
          if (f) vm.funding = f;
          const b = directional(gmFund.longBorrowRatePerHourPercent, gmFund.shortBorrowRatePerHourPercent);
          if (b) vm.borrow = b;
        }
        if (gmLiq) {
          vm.liquidity = {
            longAvailableUsd: gmLiq.longAvailableUsd ?? null,
            shortAvailableUsd: gmLiq.shortAvailableUsd ?? null,
          };
        }
        if (gmMkt && typeof gmMkt.closed === "boolean") vm.closed = gmMkt.closed;
        if (typeof gmVol === "string") vm.volumeUsd = gmVol;
        venues.gmtrade = vm;
        presentVenues.add("gmtrade");
      }
    }

    // ── jupiter (stats-only: volume share) ──
    if (venueAllowed("jupiter")) {
      const jupVol = byVenueVolume(stats?.byVenue, "jupiter");
      if (typeof jupVol === "string" && jupVol.length > 0) {
        venues.jupiter = { available: true, volumeUsd: jupVol };
        presentVenues.add("jupiter");
      }
    }

    // When a venue filter is active (known venue), drop markets with no data
    // for it. When the filter is unknown (`undefined`), all venues are gated
    // out above, so `venues` is empty and the market is dropped too.
    if (venueFilter !== null) {
      if (Object.keys(venues).length === 0) continue;
    }

    markets.push({
      symbol,
      volumeUsd: typeof stats?.volumeUsd === "string" ? stats.volumeUsd : "0",
      openInterestUsd: typeof stats?.openInterestUsd === "string" ? stats.openInterestUsd : "0",
      longOiUsd: typeof stats?.longOiUsd === "string" ? stats.longOiUsd : "0",
      shortOiUsd: typeof stats?.shortOiUsd === "string" ? stats.shortOiUsd : "0",
      traderCount: typeof stats?.traderCount === "number" ? stats.traderCount : 0,
      positionCount: typeof stats?.positionCount === "number" ? stats.positionCount : 0,
      venues,
    });
  }

  // Stable ordering: highest 24h volume first, then alpha by symbol.
  markets.sort((a, b) => {
    const av = Number(a.volumeUsd);
    const bv = Number(b.volumeUsd);
    const an = Number.isFinite(av) ? av : 0;
    const bn = Number.isFinite(bv) ? bv : 0;
    if (bn !== an) return bn - an;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });

  // ── totals ──
  const summary = safe.statsSummary;
  const byVenueTotals: Record<string, AggregatedVenueTotals> = {};
  for (const vs of arr(summary?.venues)) {
    const vk = normalizeUnderwriter(vs?.venue);
    if (!vk) continue;
    if (!venueAllowed(vk)) continue;
    // NOTE: summary has NO flash_v2 slice, so this only ever fills flash (v1),
    // phoenix, gmtrade, jupiter. flash_v2 never appears in totals.byVenue.
    if (!byVenueTotals[vk]) {
      byVenueTotals[vk] = {
        volumeUsd: typeof vs.volumeUsd === "string" ? vs.volumeUsd : "0",
        openInterestUsd: typeof vs.openInterestUsd === "string" ? vs.openInterestUsd : "0",
        traderCount: typeof vs.traderCount === "number" ? vs.traderCount : 0,
      };
      presentVenues.add(vk);
    }
  }

  const totals: AggregatedTotals = {
    volume24hUsd: typeof summary?.volume24hUsd === "string" ? summary.volume24hUsd : "0",
    volume7dUsd: typeof summary?.volume7dUsd === "string" ? summary.volume7dUsd : "0",
    volumeAllUsd: typeof summary?.volumeAllUsd === "string" ? summary.volumeAllUsd : "0",
    openInterestUsd: typeof summary?.openInterestUsd === "string" ? summary.openInterestUsd : "0",
    activeTraders24h: typeof summary?.activeTraders24h === "number" ? summary.activeTraders24h : 0,
    feeRevenue24hUsd: typeof summary?.feeRevenue24hUsd === "string" ? summary.feeRevenue24hUsd : "0",
    byVenue: byVenueTotals,
  };

  // ── venues[] — present venues honoring the filter, in canonical order ──
  const venueList: string[] = VENUE_ORDER.filter(
    (v) => presentVenues.has(v) && venueAllowed(v),
  );

  // Echo the applied venue filter so a consumer can tell "flash_v2 only because I
  // filtered" apart from "flash_v2 is all there is". null = no filter (all venues);
  // an unknown venue echoes the raw request (and yields no markets).
  const filter =
    venueFilter === null
      ? null
      : venueFilter === undefined
        ? (opts?.venue ? String(opts.venue) : null)
        : venueFilter;

  return {
    asOf,
    source: sourceLabel(safe),
    period,
    filter,
    count: markets.length,
    venues: venueList,
    totals,
    markets,
  };
}

/** Human-readable label of which Imperial reads actually contributed. */
function sourceLabel(inputs: AggregateInputs): string {
  const parts: string[] = [];
  if (inputs.statsSummary) parts.push("stats/summary");
  if (inputs.statsMarkets) parts.push("stats/markets");
  if (inputs.markPrices) parts.push("mark-prices");
  if (inputs.fundingRates) parts.push("funding-rates");
  if (inputs.flashV2Markets) parts.push("flash-v2/markets");
  if (inputs.flashMarkets) parts.push("flash/markets");
  if (inputs.phoenixMarkets) parts.push("phoenix/markets");
  if (inputs.gmtradeMarkets) parts.push("gmtrade/markets");
  if (inputs.gmtradeLiquidity) parts.push("gmtrade/liquidity");
  return parts.length ? `imperial:${parts.join("+")}` : "imperial";
}
