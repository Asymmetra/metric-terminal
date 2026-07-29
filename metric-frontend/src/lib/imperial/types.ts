/**
 * Imperial Trading API DTOs.
 *
 * Source of truth: https://api.imperial.space/api/v1/openapi.json
 * (mirrored locally during planning at /tmp/imperial_openapi.json)
 *
 * Names mirror the OpenAPI shapes verbatim (camelCase) so future code
 * generation can replace this file with no call-site churn.
 */

// ──────────────────────────────────────────────────────────── enums

/** Imperial's underwriter discriminator. Numeric on the wire. */
export const Underwriter = {
  Jupiter: 0,
  FlashTrade: 1,
  Phoenix: 2,
  GMTrade: 3,
  FlashV2: 4, // Flash's higher-leverage v2 pool (up to ~500×). Placed through the normal
  // /mobile/orders path (no separate v2 orders endpoint); the order bot auto-stages collateral
  // into the V2 UserDepositLedger at fill, so no manual /mobile/v2/deposit is required to trade.
  // passthrough_client `from_u8` maps 4→FlashTradeV2 and rejects ≥5; the OpenAPI "4 = Pacifica"
  // note is stale.
  Touch: 6, // "Imperial Touch" — barrier/no-touch binary options. NOT a perp venue: it reuses the
  // perp order RECORD (OrderRequest) with heavy FIELD OVERLOADING (see buildTouchOpenRequest /
  // buildTouchCloseRequest in touch-order.ts for the exact mapping). Touch accepts orderType 0/1/2
  // ONLY (Market/Limit/StopLimit); DCA/ratchet/landmine/tpsl are rejected. Do NOT add it to
  // VenueTag / VENUE_CONFIG — those are perp-only.
} as const;
export type Underwriter = (typeof Underwriter)[keyof typeof Underwriter];

/** Side. */
export const Side = { Long: 0, Short: 1 } as const;
export type Side = (typeof Side)[keyof typeof Side];

/** Increase / Decrease. */
export const Action = { Increase: 0, Decrease: 1 } as const;
export type Action = (typeof Action)[keyof typeof Action];

/** Order types — full Imperial set including DCA/ratchet variants. */
export const OrderType = {
  Market: 0,
  Limit: 1,
  StopLimit: 2,
  LandMine: 3,
  Ratchet: 4,
  RatchetEntry: 6,
  Dca: 9,
  FibRatchet: 10,
  FibRatchetEntry: 11,
  DcaClose: 12,
  DcaTimeClose: 13,
  DcaRatchetClose: 14,
  DcaTime: 15,
  DcaRatchet: 16,
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

/** Trigger condition relative to price (when used). */
export const TriggerCondition = { Above: 0, Below: 1 } as const;
export type TriggerCondition = (typeof TriggerCondition)[keyof typeof TriggerCondition];

/** Funding mode for a resting order. */
export const FundingStatus = { FundedAtCreation: 0 } as const;
export type FundingStatus = (typeof FundingStatus)[keyof typeof FundingStatus];

/** String-form venue tag used on read endpoints (e.g. /route, /funding-rates). */
export type VenueTag = "jupiter" | "flash_trade" | "phoenix" | "gmtrade" | "flash_v2";

// ──────────────────────────────────────────────────────────── auth

export interface ConnectRequest {
  wallet: string;        // base58 Solana pubkey
  message: string;       // exact: `imperial:mobile-connect:{wallet}:{nonce}`
  signature: string;     // base58 signature over `message`
}
export interface ConnectResponse {
  code: string;          // one-time code (5 min ttl)
}
export interface ExchangeRequest {
  code: string;
}
export interface ExchangeResponse {
  jwt: string;
  expiresAt: number;     // unix seconds
}

// ──────────────────────────────────────────────────────────── orders

/** Body of POST /mobile/orders and each leg of /mobile/orders/batch. */
export interface OrderRequest {
  wallet: string;
  profileIndex: number;          // 0..5 isolated profile
  underwriter: Underwriter;
  side: Side;
  action: Action;
  orderType: OrderType;
  sizeUsd: number;               // 1_000_000 = $1 (6-decimal fixed point)
  collateralAmount: number;      // collateral mint native units
  slippageBps: number;
  triggerCondition: TriggerCondition;
  triggerPrice: number;          // oracle scale (1e9)
  priority: number;              // funding-queue priority; lower = higher
  fundingStatus: FundingStatus;
  marketPrice?: number;          // oracle scale (1e9), client-observed
  symbol?: string | null;        // canonical (e.g. "SOL"); resolved server-side
  marketMint?: string | null;    // alternative: explicit base58 mint
  phoenixNative?: boolean | null;
  parentOrderPda?: string | null;
  extraData?: unknown;
}

/** Standard order-endpoint response (orders, cancel, update, collateral). */
export interface OrderResponse {
  success: boolean;
  signature: string | null;      // Solana tx signature when produced
  orderPda: string | null;       // resting-order PDA (limit/stop-limit/etc.)
  error: string | null;          // humanized when success=false
}

export interface BatchRequest {
  entry: OrderRequest;
  closeOrders?: OrderRequest[];
}
export interface BatchResponse {
  entry: OrderResponse;
  closeOrders: OrderResponse[];
}

export interface CancelRequest {
  wallet: string;
  profileIndex: number;
  orderPda: string;
}

export interface UpdateRequest {
  wallet: string;
  profileIndex: number;
  orderPda: string;
  sizeUsd?: number | null;
  triggerPrice?: number | null;
  slippageBps?: number | null;
  closeBps?: number | null;     // 0..10000
  priority?: number | null;
  proOrderUpdate?:
    | null
    | { type: "ratchet" | "landMine"; ratchetSize?: number; worstPrice?: number; waitPrice?: number; waitDurationSeconds?: number };
}

export interface CollateralRequest {
  wallet: string;
  profileIndex: number;
  underwriter: Underwriter;
  side: Side;
  action: Action;                // 0=add collateral, 1=remove
  collateralAmount: number;
  marketMint: string;
  price: number;                 // oracle scale (1e9)
  slippageBps: number;
}

// ─────────────────────────────────────────────────────── deposit/withdraw

export interface DepositRequest {
  wallet: string;
  profileIndex: number;
  amount: number;                // USDC native units (1_000_000 = $1)
  mode: "deposit" | "withdraw";
}
export interface DepositResponse {
  /** Base64 partially-signed VersionedTransaction. */
  transaction: string;
}

// ─────────────────────────────────────────────── profile sweep / activation

/** Body of POST /phoenix/register — optional Phoenix pre-activation (no auth). */
export interface RegisterPhoenixRequest {
  wallet: string;
  profileIndex?: number; // 0..5; defaults to 0 server-side
}
export interface RegisterPhoenixResponse {
  profilePda: string;
  activated: boolean;
  message: string;
}

/** Pre-sweep snapshot of tokenized residue (native scales). */
export interface SweepBalances {
  SOL: number;
  BTC: number;
  ETH: number;
}
/**
 * Response of POST /passthrough/users/{wallet}/profiles/{index}/sync.
 * `status`: "clean" (nothing to sweep) | "queued" (recent sweep in flight) |
 * "swept" (operator submitted instructions to return WSOL/WBTC/WETH residue
 * to the wallet as USDC).
 */
export interface SyncSweepResponse {
  status: "clean" | "queued" | "swept" | string;
  message: string;
  balances?: SweepBalances | null;
}

// ──────────────────────────────────────────────────────────── reads

export interface ProfileBalance {
  profileIndex: number;
  profilePda: string;
  usdc: number;                  // native USDC units
}
export interface BalancesResponse {
  wallet: string;
  profiles: ProfileBalance[];
}

export interface RouteCandidate {
  venue: VenueTag;
  expectedCostUsd: number;
  maxLeverage: number;
  filteredReason: string | null;
  costBreakdown: CostBreakdown;
}
export interface CostBreakdown {
  openFee: number;
  openSlip: number;
  closeFee: number;
  closeSlip: number;
  borrow: number;
  pLiq: number;
  expectedLiqCost: number;
  total: number;
}
export interface RouteResponse {
  venue: VenueTag;
  reason: string;
  expectedCostUsd: number;
  maxLeverage: number;
  clamped: boolean;
  clampedMaxLeverage: number | null;
  costBreakdown: CostBreakdown;
  candidates: RouteCandidate[];
}

/**
 * GET /status — Imperial component health. `orderBot.status` is the one that
 * gates trading: it's the bot that submits/executes every order across all
 * venues, so when it's "unhealthy" no order can place (the failure surfaces as
 * "Failed to place order — please try again" or "Imperial internal error").
 */
export interface ImperialStatus {
  db: string;
  indexer: { status: string; grpcStream?: string; db?: string; lastProcessedSlot?: number };
  orderBot: { status: string; rpc?: string };
}

export interface FundingRateRow {
  symbol: string;
  jupiter: VenueFundingRate | null;
  flash: VenueFundingRate | null;
  phoenix: VenueFundingRate | null;
  gmtrade: VenueFundingRate | null;
}
export interface VenueFundingRate {
  source: string;
  longFundingRatePerHourPercent: number | null;
  shortFundingRatePerHourPercent: number | null;
  longBorrowRatePerHourPercent: number | null;
  shortBorrowRatePerHourPercent: number | null;
}

export interface MarkPriceRow {
  symbol: string;
  jupiter: VenueMarkPrice | null;
  flash: VenueMarkPrice | null;
  phoenix: VenueMarkPrice | null;
  gmtrade: VenueMarkPrice | null;
}
export interface VenueMarkPrice {
  price: number;
  source: string;
  fetchedAtUnixMs: number;
}

/** Position lifecycle row from /positions or /trades. Subset only. */
export interface PositionLifecycle {
  id: string;
  wallet: string;
  underwriter: string;
  source: string;
  asset: string;
  status: string;
  side: string;
  positionPda: string;
  profileIndex: number | null;
  openedAt: number;
  closedAt: number | null;
  lastActionAt: number;
  sizeUsd: string | null;
  collateralUsd: string | null;
  entryPrice: string | null;
  markPrice: string | null;
  liquidationPrice: string | null;
  leverageX: string | null;
  pnlUsd: string | null;
  pnlPercent: string | null;
  totalFeesUsd: string;
  actions: PositionAction[];
  tpslOrders: TpSlOrder[];
}
export interface PositionAction {
  id: string;
  sequenceNumber: number;
  actionType: string;
  status: string;
  tx1Signature: string;
  tx1Timestamp: number;
  sizeDelta: string | null;
  collateralDelta: string | null;
  pnlRealized: string | null;
  triggerPrice: string | null;
  triggerCondition: string | null;
  orderType: string | null;
}
export interface TpSlOrder {
  orderPda: string | null;
  orderType: string;
  source: string;
  sizeUsd: string;
  triggerPriceUsd: string;
  triggerCondition: string | null;
  closeBps: number | null;
  profileIndex: number | null;
}
export interface PositionList {
  count: number;
  totalCount: number;
  dataList: PositionLifecycle[];
  lifetimePnlUsd: string;
  lifetimeFeesUsd: string;
  lifetimeCollateralUsd: string;
}

// ──────────────────────────────────────────────────────────── pnl history

/**
 * One point on the cumulative-PnL curve from GET /pnl-history. `resolution`
 * (1m/1h/1d/…) controls bucket width; numeric USD fields are in plain dollars.
 */
export interface PnlHistoryPoint {
  timestamp: number;
  cumulativePnl: number;
  cumulativeTakerFee: number;
  cumulativeFundingPayment: number;
  unrealizedPnl: number | null;
}

// ──────────────────────────────────────────────────────────── stats

/** Per-venue volume + OI slice inside GET /stats/summary. */
export interface VenueStats {
  venue: string;
  volumeUsd: string;
  openInterestUsd: string;
  traderCount: number;
}
/** GET /stats/summary — protocol-wide headline figures (Usd fields are decimal strings). */
export interface StatsSummaryResponse {
  asOf: string;
  volume24hUsd: string;
  volume7dUsd: string;
  volumeAllUsd: string;
  openInterestUsd: string;
  activeTraders24h: number;
  feeRevenue24hUsd: string;
  venues: VenueStats[];
}

/** Per-venue volume split for a market row in GET /stats/markets. */
export interface MarketVenueVolume {
  jupiterUsd: string;
  flashUsd: string;
  phoenixUsd: string;
  gmtradeUsd: string;
}
export interface MarketRow {
  symbol: string;
  volumeUsd: string;
  openInterestUsd: string;
  longOiUsd: string;
  shortOiUsd: string;
  positionCount: number;
  traderCount: number;
  byVenue: MarketVenueVolume;
}
/** GET /stats/markets — per-market volume + OI breakdown. */
export interface MarketsResponse {
  period: string;
  rows: MarketRow[];
}

/** One time bucket of volume from GET /stats/volume. */
export interface VolumeBucket {
  timestamp: string;
  totalUsd: string;
  jupiterUsd: string;
  flashUsd: string;
  phoenixUsd: string;
  gmtradeUsd: string;
  tradeCount: number;
}
/** GET /stats/volume — time-bucketed volume series. */
export interface VolumeResponse {
  period: string;
  grouping: string;
  rows: VolumeBucket[];
}

/** One grouped open-interest row from GET /stats/open-interest. */
export interface OpenInterestRow {
  label: string;
  longUsd: string;
  shortUsd: string;
  totalUsd: string;
  positionCount: number;
  traderCount: number;
}
/** GET /stats/open-interest — open interest grouped by venue/market/etc. */
export interface OpenInterestResponse {
  asOf: string;
  grouping: string;
  rows: OpenInterestRow[];
}

// ──────────────────────────────────────────────────────────── passthrough orders

/** A single order row from GET /passthrough/users/{wallet}/orders. */
export interface PassthroughOrder {
  wallet: string;
  profileIndex: number;
  profilePda: string;
  orderPda: string;
  parentOrderPda: string | null;
  underwriter: string;
  marketMint: string;
  side: string;
  action: string;
  orderType: string;
  status: string;
  sizeUsd: string;
  collateralAmount: string;
  slippageBps: number;
  triggerCondition: string | null;
  triggerPrice: string | null;
  createdAt: number;
  creationSlot: number;
  creationSignature: string;
  executedAt: number | null;
  executionSignature: string | null;
  cancelledAt: number | null;
  orderData?: unknown;
  venueOrderState?: unknown;
}
export interface PassthroughOrdersResponse {
  count: number;
  orders: PassthroughOrder[];
}

// ──────────────────────────────────────────────────────── imperial touch
//
// Barrier/no-touch binary options ("Imperial Touch", underwriter 6). Each TENOR
// is its own market (verified live): SOL 24h/1h/5m = marketId 6/7/8, BTC =
// 9/10/11, distinguished by `config.cohortWindowSecs` (86400 / 3600 / 300).
// All numeric-scale fields keep Imperial's on-wire scale (see per-field notes);
// prices are 1e9 oracle scale, USD payouts/premiums are µUSD (6-decimal).

/** `config` block of a {@link TouchMarketRow} — the pricing/risk knobs for a tenor. */
export interface TouchConfigView {
  cohortQuantumSecs: number;   // grid step cohorts snap to
  cohortWindowSecs: number;    // TENOR: 86400=24h, 3600=1h, 300=5m
  minPayoutUsd: number;        // µUSD floor on sizeUsd (payout)
  maxPayoutUsd: number;        // µUSD ceiling on sizeUsd (payout)
  floorBps: number;            // min ask
  ceilBps: number;             // max ask
  alphaBps: number;
  beta1e6: number;
  gamma1e6: number;
  eScaleUsd: number;
  kImplied1e3: number;
  minImpliedDtSecs: number;
  sigmaMaxAgeSecs: number;
  perBarrierCapBps: number;
  portfolioCapBps: number;
  wTauSecs: number[];
  w1e6: number[];
  fD1e6: number[];
  fP1e6: number[];
}

/** `vol` block of a {@link TouchMarketRow} — live volatility snapshot (1e9-scaled). */
export interface TouchVolView {
  sigmaShort1e9: number;
  sigmaLong1e9: number;
  sigmaTouchFloor1e9: number;
  anchorSpot1e9: number;
  postTs: number;              // unix seconds of the snapshot
  widenMult1e3: number;
  navSnapshotUsd: number;      // µUSD
}

/** `book` block of a {@link TouchMarketRow} — underwriter reserve/liability snapshot (µUSD). Null on empty tenors. */
export interface TouchBookView {
  rawReserveUsd: number;
  fairMarkLiabilityUsd: number;
  stressUsageUsd: number;
  eCrashUsd: number;
  eMeltupUsd: number;
}

/**
 * One tenor of one touch underlying from GET /touch/markets (no auth).
 * `symbol` is the family (e.g. "SOLTOUCH"; the underlying is the prefix before
 * "TOUCH"). `halted: true` ⇒ render read-only. `marketId` is the tenor id, but
 * addressing a specific tenor requires the market PDA (not exposed) — see
 * buildTouchOpenRequest's marketMint note.
 */
export interface TouchMarketRow {
  symbol: string;
  marketId: number;
  halted: boolean;
  spotPrice1e9: number;        // current underlying spot, 1e9 oracle scale
  config: TouchConfigView;
  vol: TouchVolView;
  book: TouchBookView | null;
}

/**
 * One ranked barrier quote from GET /touch/deals (no auth, cached ~60s so
 * `askBps` is INDICATIVE). Ranked ±1/2/3/5/8% both sides, top 12.
 *   premium = payout * askBps / 10000
 * `barrier1e9` is sent as `triggerPrice` on a Touch buy.
 */
export interface TouchDealRow {
  marketId: number;
  symbol: string;
  isTouch: boolean;            // true = Touch (pays if barrier reached), false = No-Touch
  barrier1e9: number;          // barrier price, 1e9 oracle scale
  askBps: number;              // indicative ask, bps of payout
}

/**
 * One position from GET /touch/positions?walletAddress= (no auth). NOT on
 * /positions or /ws — POLL (~3s). Open first, then finished newest-first, cap 200.
 * Use `openTs`/`expiryTs` from the row (cohort clock); do NOT derive expiry as
 * now+tenor.
 */
export interface ApiTouchPosition {
  positionId: number;          // from 0
  marketId: number;
  symbol: string;
  isTouch: boolean;
  barrier1e9: number;          // 1e9 oracle scale
  payoutUsd: number;           // µUSD — echo BYTE-FOR-BYTE into a close's sizeUsd
  premiumUsd: number;          // µUSD actually paid
  askBps: number;
  openTs: number;              // unix seconds
  expiryTs: number;            // unix seconds (cohort clock)
  status: "open" | "settled" | "bought_back";
  won: boolean | null;
  payoutPaidUsd: number | null; // µUSD paid at settlement, null until finished
  openTxSig: string;
  settleTxSig: string | null;
  settledAt: number | null;    // unix seconds
}

// ──────────────────────────────────────────────────────────── points

/**
 * GET /mobile/points?walletAddress= — Imperial season points. REQUIRES the JWT
 * (401 "Missing Authorization header" without it). `seasonName` is null when no
 * season is live (both point figures then 0).
 */
export interface PointsResponse {
  wallet: string;
  seasonName: string | null;
  seasonPoints: number;        // whole points (micros / 1e6, floored)
  seasonPointsMicros: number;  // micro-points (6 decimals)
}

// ──────────────────────────────────────────────────────── order history

/** Optional aggregate for a DCA parent row in {@link OrderHistoryRow}. */
export interface DcaSummary {
  legsExecuted: number;
  numLegs: number;
  fillCount: number;
  avgFillPrice: string | null;
}
/** Additive, user-safe error metadata attached to a rejected order/fill/event. */
export interface UserErrorDetails {
  code: string;
  message: string;
  action: string | null;
  outcome: string | null;
  referenceId: string | null;
}

/**
 * One row from GET /order-history?walletAddress= (no auth). USD fields are
 * decimal STRINGS in native units (sizeUsd/collateralAmount are 6-dec µUSD
 * strings; prices are 1e9-scale strings). Timestamps are unix seconds.
 */
export interface OrderHistoryRow {
  orderPda: string;
  parentOrderPda: string | null;
  marketMint: string;
  side: string;
  orderType: string;
  action: string;
  underwriter: string;
  profileIndex: number;
  sizeUsd: string;
  collateralAmount: string;
  slippageBps: number;
  triggerCondition: string | null;
  triggerPrice: string | null;
  displayStatus: string;       // derived user-facing status
  status: string;              // raw DB status
  statusReason: string | null;
  statusReasonCode: string | null;
  creationSignature: string;
  createdAt: number;
  cancelledAt: number | null;
  executedAt: number | null;
  executionSignature: string | null;
  executionTriggerPrice: string | null;
  avgFillPrice: string | null;
  bestPriceSeen: string | null;
  filledSizeUsd: string | null;
  fillCount: number;
  childCount: number;
  botState: string | null;
  venueOrderId: string | null;
  dca?: DcaSummary | null;
  ratchet?: unknown;
  indicator?: unknown;
}
export interface OrderHistoryResponse {
  orders: OrderHistoryRow[];
  totalCount: number;
}

// ──────────────────────────────────────────────────────── funding history

/**
 * One funding/borrow settlement from GET /funding-history?walletAddress=
 * (no auth). `amount` is signed µUSD as a STRING (positive = trader paid).
 * `rate` is the effective per-second rate ×10^`rateScale` (string).
 */
export interface FundingEventRow {
  id: string;
  lifecycleId: string;
  actionId: string | null;
  underwriter: string;
  marketMint: string;
  symbol: string;
  side: string;
  eventType: string;           // "funding_settled" | "borrow_settled"
  amount: string;              // signed µUSD
  positionSizeUsd: string | null;
  positionSizeAfterUsd: string | null;
  rate: string | null;
  rateScale: number;
  spanStart: number | null;    // unix seconds
  spanEnd: number | null;      // unix seconds
  signature: string | null;
  eventAt: number;             // unix seconds
  payload?: unknown;
}
export interface FundingAggregates {
  totalPaid: string;           // µUSD magnitude
  totalReceived: string;       // µUSD magnitude
  net: string;                 // signed µUSD (paid − received)
}
export interface FundingHistoryResponse {
  events: FundingEventRow[];
  totalCount: number;
  aggregates: FundingAggregates;
}
