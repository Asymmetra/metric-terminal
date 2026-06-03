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
  // 4 is reserved (Pacifica) and rejected today.
  FlashV2: 5, // Flash's higher-leverage v2 pool (up to ~500×). Undocumented in the
  // OpenAPI `underwriter` description, but present in the `Venue` enum and confirmed.
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
