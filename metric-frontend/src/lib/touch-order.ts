/**
 * Pure builders that turn Imperial Touch UI inputs into an OrderRequest.
 *
 * Imperial Touch (underwriter 6) is a barrier/no-touch binary option. It reuses
 * the perp `OrderRequest` RECORD with heavy FIELD OVERLOADING — the mapping in
 * this file IS the contract (verified against the live API; this is a money
 * path, so it is built exactly to spec). Touch accepts orderType 0/1/2 ONLY
 * (Market/Limit/StopLimit); every builder here uses Market (0).
 *
 * Units:
 *   barrier1e9 (→ triggerPrice on a buy) : 1e9 oracle scale (the on-wire barrier)
 *   payoutUsd  (→ sizeUsd)               : µUSD, 6-decimal (config.minPayoutUsd..maxPayoutUsd)
 *   premiumUsd (→ collateralAmount on buy): µUSD, the MAX premium budget you'll pay;
 *                                           the fill debits the live ask and refunds the rest
 *
 * TENOR (critical): to address a specific tenor you must send `marketMint` = the
 * market PDA, which is DERIVED FROM marketId but is NOT returned by the API and
 * NOT derivable client-side (seeds unknown). A bare `symbol` ("SOLTOUCH") resolves
 * server-side to the LOWEST marketId = the 24h tenor. So v1 trades the 24h tenor
 * via bare symbol. These builders accept an OPTIONAL `marketMint` and PREFER it
 * when present, falling back to `symbol`.
 * TODO(imperial): expose the market PDA for 1h/5m tenors so `marketMint` can be
 * passed and non-24h tenors traded. Do NOT invent/derive the PDA.
 */

import {
  Action,
  FundingStatus,
  OrderType,
  Side,
  TriggerCondition,
  Underwriter,
  type OrderRequest,
} from "@/lib/imperial/types";

/**
 * Premium BUDGET (µUSD) to send as `collateralAmount` on a Touch buy: the max
 * you're willing to pay. Since `/touch/deals` askBps is only INDICATIVE (cached
 * ~60s), we add slack so a small live-ask move doesn't reject the order —
 *   budget = ceil(payout * askBps / 10000) + slack,  slack = round(payout * 0.01)
 * i.e. 100 bps of payout of headroom (per Imperial's homepage), guaranteeing at
 * least ~1 cent of budget per $1 of payout. The fill debits the true ask and
 * refunds the difference. If the live ask still outran the budget the order
 * fails with errorCode `TouchQuoteMoved` — re-read /touch/deals and retry.
 */
export function touchPremiumBudget(payoutUsd: number, askBps: number): number {
  const indicative = Math.ceil((payoutUsd * askBps) / 10000);
  const slack = Math.round(payoutUsd * 0.01);
  return indicative + slack;
}

/** Prefer an explicit market PDA (specific tenor) over the bare symbol (24h). */
function marketFields(symbol: string, marketMint?: string | null): {
  symbol: string | null;
  marketMint: string | null;
} {
  return marketMint ? { symbol: null, marketMint } : { symbol, marketMint: null };
}

export interface TouchOpenParams {
  wallet: string;
  profileIndex: number;
  /** Touch family symbol, e.g. "SOLTOUCH". Used when `marketMint` is absent (24h tenor). */
  symbol: string;
  /** Market PDA for a specific tenor. Prefer when present; else the bare symbol resolves to 24h. */
  marketMint?: string | null;
  /** true = Touch (pays if spot reaches the barrier before expiry); false = No-Touch (pays if it never does). */
  isTouch: boolean;
  /** Barrier price, 1e9 oracle scale (from a TouchDealRow.barrier1e9). */
  barrier1e9: number;
  /** Payout, µUSD (within config.minPayoutUsd..maxPayoutUsd). Sent as sizeUsd. */
  payoutUsd: number;
  /** Max premium you'll pay, µUSD (see {@link touchPremiumBudget}). Sent as collateralAmount. */
  premiumBudgetUsd: number;
}

/**
 * BUY (open) a touch position — POST /mobile/orders (JWT).
 * Field overloading (this mapping IS the contract):
 *   underwriter 6, side 0=Touch / 1=No-Touch, action 0 (open), orderType 0 (Market),
 *   triggerCondition 0, triggerPrice = BARRIER (1e9), sizeUsd = PAYOUT (µUSD),
 *   collateralAmount = PREMIUM BUDGET (µUSD, the max; the fill refunds the difference),
 *   slippageBps 0.
 * On errorCode `TouchQuoteMoved` the live ask outran the budget — re-read
 * /touch/deals for a fresh askBps and rebuild (bounded retries).
 */
export function buildTouchOpenRequest(params: TouchOpenParams): OrderRequest {
  return {
    wallet: params.wallet,
    profileIndex: params.profileIndex,
    underwriter: Underwriter.Touch,
    side: params.isTouch ? Side.Long : Side.Short, // 0 = Touch, 1 = No-Touch
    action: Action.Increase, // 0 = open
    orderType: OrderType.Market, // 0 — Touch accepts 0/1/2 only
    sizeUsd: params.payoutUsd, // PAYOUT, µUSD
    collateralAmount: params.premiumBudgetUsd, // PREMIUM BUDGET (max), µUSD
    slippageBps: 0,
    triggerCondition: TriggerCondition.Above, // 0
    triggerPrice: params.barrier1e9, // the BARRIER, 1e9 scale
    priority: 0,
    fundingStatus: FundingStatus.FundedAtCreation,
    ...marketFields(params.symbol, params.marketMint),
  };
}

export interface TouchCloseParams {
  wallet: string;
  profileIndex: number;
  symbol: string;
  marketMint?: string | null;
  /** Position id from /touch/positions (from 0). Sent as triggerPrice = positionId + 1 (an ID, not a price). */
  positionId: number;
  /**
   * The position's payoutUsd echoed BYTE-FOR-BYTE from /touch/positions. A
   * re-derived, rounding-different value is REFUSED. Sent as sizeUsd.
   */
  payoutUsd: number;
  /** Minimum-refund floor, µUSD (0 = accept any bid). Sent as collateralAmount. */
  minRefundUsd: number;
}

/**
 * SELL BACK (early close) a touch position — POST /mobile/orders (JWT).
 * Field overloading:
 *   underwriter 6, action 1 (close), orderType 0 (Market),
 *   triggerPrice = positionId + 1 (an ID, NOT a price, NOT 1e9-scaled; id 0 → 1),
 *   sizeUsd = the position payoutUsd echoed BYTE-FOR-BYTE from /touch/positions,
 *   collateralAmount = min-refund floor µUSD (0 = accept any bid).
 * Errors: TouchQuoteMoved, TouchBarrierSwept (pick another barrier/cohort),
 * TouchSettlesAtExpiry (wait), PositionAlreadyClosed.
 */
export function buildTouchCloseRequest(params: TouchCloseParams): OrderRequest {
  return {
    wallet: params.wallet,
    profileIndex: params.profileIndex,
    underwriter: Underwriter.Touch,
    side: Side.Long, // unused for close; server keys off positionId
    action: Action.Decrease, // 1 = close / sell back
    orderType: OrderType.Market, // 0
    sizeUsd: params.payoutUsd, // echo payoutUsd byte-for-byte
    collateralAmount: params.minRefundUsd, // min-refund floor µUSD (0 = any bid)
    slippageBps: 0,
    triggerCondition: TriggerCondition.Above, // 0
    triggerPrice: params.positionId + 1, // positionId + 1 (an ID, not a price)
    priority: 0,
    fundingStatus: FundingStatus.FundedAtCreation,
    ...marketFields(params.symbol, params.marketMint),
  };
}
