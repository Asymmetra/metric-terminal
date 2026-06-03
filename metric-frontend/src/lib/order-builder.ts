/**
 * Pure helpers to turn terminal UI inputs into an Imperial OrderRequest.
 *
 * Units (from lib/imperial/types.ts + the live test tests/imperial-live.mjs):
 *   sizeUsd / collateralAmount : 6-decimal fixed point ($1 → 1_000_000)
 *   triggerPrice / marketPrice : oracle scale ($1 → 1e9)
 *   $10 minimum collateral is enforced by Imperial's order bot.
 *
 * Limit semantics (mirrors the proven live-test order): a long rests *below*
 * the mark (triggerCondition Below); a short rests *above* (triggerCondition
 * Above). Market orders carry the observed mark as marketPrice.
 */

import {
  Action,
  FundingStatus,
  OrderType,
  Side,
  TriggerCondition,
  Underwriter,
  type OrderRequest,
  type VenueTag,
} from "@/lib/imperial/types";

export const USD_SCALE = 1_000_000; // 6-decimal fixed point
export const PRICE_SCALE = 1_000_000_000; // 1e9 oracle scale
export const MIN_COLLATERAL_USD = 10;

/**
 * SINGLE SOURCE OF TRUTH for the per-venue facts Imperial does NOT expose at
 * runtime: the numeric `underwriter` code for `/mobile/orders`, the market-order
 * `marketPrice` scale, the key the venue uses in `/mark-prices` rows, and a display
 * label. Everything else is fetched live — which assets exist (`/mark-prices`),
 * per-venue max leverage + fees + quotes (`/route`, `/mark-prices`), and routing
 * (`/route` candidates). To support a new venue Imperial adds, add its tag to
 * `VenueTag` (imperial/types) and one entry here; the dropdown, venue-quotes panel,
 * routing, and order builder all read from this.
 */
export interface VenueConfig {
  label: string;
  underwriter: Underwriter;
  /** Scale for a market order's `marketPrice` (Phoenix wants 1e6; others 1e9). */
  marketPriceScale: number;
  /** Key this venue uses in a `/mark-prices` row / `marksByVenue`. */
  markKey: string;
}
export const VENUE_CONFIG: Record<VenueTag, VenueConfig> = {
  phoenix: { label: "Phoenix", underwriter: Underwriter.Phoenix, marketPriceScale: USD_SCALE, markKey: "phoenix" },
  jupiter: { label: "Jupiter", underwriter: Underwriter.Jupiter, marketPriceScale: PRICE_SCALE, markKey: "jupiter" },
  flash_trade: { label: "Flash", underwriter: Underwriter.FlashTrade, marketPriceScale: PRICE_SCALE, markKey: "flash" },
  // Flash's higher-leverage v2 pool. Shares Flash's `flash` custody-oracle price feed
  // (no distinct /mark-prices key), same 1e9 market-price scale, but its own underwriter code.
  flash_v2: { label: "Flash v2", underwriter: Underwriter.FlashV2, marketPriceScale: PRICE_SCALE, markKey: "flash" },
  gmtrade: { label: "GMTrade", underwriter: Underwriter.GMTrade, marketPriceScale: PRICE_SCALE, markKey: "gmtrade" },
};

/** Venue tags in display order, derived from the config (no separate hardcoded list). */
export const ALL_VENUE_TAGS = Object.keys(VENUE_CONFIG) as VenueTag[];

/** Human label for any venue string — falls back to a title-cased tag for unknowns. */
export function venueLabel(v: string): string {
  return VENUE_CONFIG[v as VenueTag]?.label ?? v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface OrderFormInput {
  wallet: string;
  profileIndex: number; // 0..5
  symbol: string; // canonical asset, e.g. "SOL"
  venue: VenueTag;
  side: "long" | "short";
  type: "market" | "limit";
  /** Position notional in display dollars. */
  sizeUsd: number;
  /** Collateral in display dollars (USDC). */
  collateralUsd: number;
  /** Current mark in display dollars (oracle reference). */
  markPrice: number;
  /** Limit price in display dollars — required when type === "limit". */
  limitPrice?: number;
  slippageBps: number;
}

export function toUsdFixed(dollars: number): number {
  return Math.round(dollars * USD_SCALE);
}
export function toOracle(dollars: number): number {
  return Math.round(dollars * PRICE_SCALE);
}

/**
 * A MARKET order's `marketPrice` is venue-scaled (see `VENUE_CONFIG`): Phoenix wants
 * the 6-decimal USD scale (1e6) while GMTrade/Jupiter/Flash want oracle scale (1e9).
 * Passing 1e9 to Phoenix is "1000× off" → the keeper rejects with a generic error.
 * (Phoenix *limit* `triggerPrice` still uses 1e9 — only market `marketPrice` differs.)
 * Unknown venues default to oracle scale.
 */
export function toMarketPrice(dollars: number, venue: VenueTag): number {
  return Math.round(dollars * (VENUE_CONFIG[venue]?.marketPriceScale ?? PRICE_SCALE));
}

/** Returns a human error string if the input can't be submitted, else null. */
export function validateOrder(input: OrderFormInput): string | null {
  if (!input.wallet) return "Connect a wallet first.";
  if (!(input.sizeUsd > 0)) return "Enter a position size.";
  if (!(input.collateralUsd >= MIN_COLLATERAL_USD))
    return `Collateral must be at least $${MIN_COLLATERAL_USD}.`;
  if (input.collateralUsd > input.sizeUsd)
    return "Collateral can't exceed position size.";
  if (input.type === "limit" && !(Number(input.limitPrice) > 0))
    return "Enter a limit price.";
  if (!(input.markPrice > 0)) return "Waiting for a mark price…";
  return null;
}

/** Effective leverage implied by size / collateral. */
export function impliedLeverage(sizeUsd: number, collateralUsd: number): number {
  if (!(collateralUsd > 0)) return 0;
  return sizeUsd / collateralUsd;
}

export function buildOrderRequest(input: OrderFormInput): OrderRequest {
  const side = input.side === "long" ? Side.Long : Side.Short;
  const isLimit = input.type === "limit";

  // Long limits rest below mark; short limits rest above.
  const triggerCondition =
    side === Side.Long ? TriggerCondition.Below : TriggerCondition.Above;

  return {
    wallet: input.wallet,
    profileIndex: input.profileIndex,
    underwriter: VENUE_CONFIG[input.venue].underwriter,
    side,
    action: Action.Increase,
    orderType: isLimit ? OrderType.Limit : OrderType.Market,
    sizeUsd: toUsdFixed(input.sizeUsd),
    collateralAmount: toUsdFixed(input.collateralUsd),
    slippageBps: input.slippageBps,
    triggerCondition: isLimit ? triggerCondition : TriggerCondition.Above,
    triggerPrice: isLimit ? toOracle(Number(input.limitPrice)) : 0,
    priority: 0,
    fundingStatus: FundingStatus.FundedAtCreation,
    marketPrice: toMarketPrice(input.markPrice, input.venue),
    symbol: input.symbol,
  };
}

/** Build a reduce (close) order for an open position of the given side. */
export function buildCloseRequest(params: {
  wallet: string;
  profileIndex: number;
  symbol: string;
  venue: VenueTag;
  positionSide: "long" | "short";
  sizeUsd: number; // display dollars to close
  markPrice: number;
  slippageBps: number;
}): OrderRequest {
  const side = params.positionSide === "long" ? Side.Long : Side.Short;
  return {
    wallet: params.wallet,
    profileIndex: params.profileIndex,
    underwriter: VENUE_CONFIG[params.venue].underwriter,
    side,
    action: Action.Decrease,
    orderType: OrderType.Market,
    sizeUsd: toUsdFixed(params.sizeUsd),
    collateralAmount: 0,
    slippageBps: params.slippageBps,
    triggerCondition: TriggerCondition.Above,
    triggerPrice: 0,
    priority: 0,
    fundingStatus: FundingStatus.FundedAtCreation,
    marketPrice: toMarketPrice(params.markPrice, params.venue),
    symbol: params.symbol,
  };
}
