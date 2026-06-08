"use client";

/**
 * Orchestrated "Deposit & Trade" / "Close & Withdraw" flows.
 *
 * Imperial executes orders via its delegated order bot (server-side, off the
 * client's transaction) — only deposit/withdraw are client-signed txs. So a
 * single atomic Solana tx is impossible; instead we sequence the two halves so
 * the user signs exactly ONCE per direction:
 *
 *   open  : [maybe] deposit (1 wallet sig, also creates the account on first use)
 *           → wait for funds to land → place Increase order (bot, no sig)
 *   close : place Decrease order (bot, no sig) → wait for settle → sweep residue
 *           → withdraw full free balance (1 wallet sig)
 *
 * This module is deliberately decoupled from React/web3: it takes its Imperial
 * client, signer, an optional RPC `confirm`, and an `onStep` reporter as deps,
 * so it's unit-testable and the SignerProvider interface stays unchanged.
 */

import { imperial as defaultImperial } from "@/lib/imperial";
import type {
  BalancesResponse,
  DepositResponse,
  OrderResponse,
  RouteResponse,
  SyncSweepResponse,
  VenueTag,
} from "@/lib/imperial/types";
import type { SignerProvider } from "@/lib/wallet/types";
import {
  buildCloseRequest,
  buildOrderRequest,
  toUsdFixed,
  type OrderFormInput,
} from "@/lib/order-builder";

// ───────────────────────────────────────────────────────────── pure math

/**
 * USDC (native, 6-dec) to deposit so the profile can fund exactly `collateralUsd`,
 * given its current free balance. Returns 0 when already covered. No buffer —
 * the order debits exactly `collateralAmount` and venue fees are netted into the
 * position, not taken from the profile's free balance (verified live), so the
 * deposit equals the collateral the user entered.
 */
export function depositShortfallNative(collateralUsd: number, profileFreeNative: number): number {
  return Math.max(0, toUsdFixed(collateralUsd) - profileFreeNative);
}

/**
 * Ordered venues to attempt a market order on. Imperial's /route ranks by COST
 * and is order-type-blind. We **honor its pick** (including Phoenix — Phoenix
 * market orders fill once `marketPrice` is sent at the right scale; see
 * `toMarketPrice` in order-builder) and list the remaining candidates after it in
 * cost order, so the caller falls through to the next-cheapest venue only if the
 * router's choice genuinely rejects. We never hardcode GMTrade (it has issues at
 * scale); GMTrade is used only as a last resort when `/route` is unavailable.
 *
 *  - market: `[route.venue, ...other viable candidates in cost order]`, filtering
 *    only `filteredReason`. An explicit user venue choice goes first. If `/route`
 *    is down, falls back to the selected venue or GMTrade.
 *  - limit: just the selected venue (or route's pick) — Phoenix limits rest fine.
 */
export function marketVenueCandidates(args: {
  type: "market" | "limit";
  selectedVenue: VenueTag | "auto";
  route?: RouteResponse | null;
}): VenueTag[] {
  const { type, selectedVenue, route } = args;
  if (type === "limit") {
    const v = selectedVenue !== "auto" ? selectedVenue : route?.venue ?? "phoenix";
    return [v];
  }
  const cands = route?.candidates ?? [];
  if (cands.length === 0) {
    // Router unavailable — honor an explicit pick, else GMTrade (generic market venue).
    return [selectedVenue !== "auto" ? selectedVenue : "gmtrade"];
  }
  const viable = cands.filter((c) => !c.filteredReason).map((c) => c.venue); // keep Phoenix
  // Honor the router: its chosen venue first, then the rest in cost order.
  const head = route?.venue;
  let ordered = head ? [head, ...viable.filter((v) => v !== head)] : viable;
  if (ordered.length === 0) return [];
  // An explicit (non-auto) venue choice wins.
  if (selectedVenue !== "auto") {
    ordered = [selectedVenue, ...ordered.filter((v) => v !== selectedVenue)];
  }
  return [...new Set(ordered)];
}

function profileFree(balances: BalancesResponse, profileIndex: number): number {
  return balances.profiles.find((p) => p.profileIndex === profileIndex)?.usdc ?? 0;
}

/**
 * True when an order rejection looks like a transient market-cache miss rather than
 * a hard rejection. Imperial's Flash V2 market list is populated at RUNTIME (the
 * `flash_v2_market_cache` refreshes ~every 60s and is empty until the first fetch),
 * so a freshly-served instance can briefly fail to resolve a symbol that `/route`
 * already offers ("could not resolve symbol SOL for underwriter 4; check that the
 * venue lists this market"). That's worth one retry on the same venue, unlike a hard
 * rejection (insufficient margin, max leverage, etc.) which should fall through.
 */
export function isTransientResolveError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /could not resolve symbol|resolve market|venue lists this market|market cache/i.test(error);
}

/**
 * True when an order rejection looks retryable rather than terminal. Imperial's
 * async market-order path (`execute_magic_trade_market`) can fail to *submit* on
 * a transient backend/RPC hiccup and reply "Failed to place order — please try
 * again" — common on the high-leverage Flash V2 path (400×/495×). The deposit has
 * already landed, so re-placing the same order is free; retrying a few times turns
 * a flaky open into a successful one. Terminal rejections (insufficient margin,
 * max leverage, invalid market) don't match these patterns and fall through.
 */
export function isRetryableOrderError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /please try again|failed to place order|try again|temporar|timed?\s?out|timeout|unavailable|too many requests|rate.?limit|\b(429|503|502|504)\b/i.test(
    error
  );
}

// ───────────────────────────────────────────────────────────── deps + steps

/** Subset of the Imperial client this module needs (injectable for tests). */
export interface FlowApi {
  getBalances(jwt: string): Promise<BalancesResponse>;
  placeOrder(req: ReturnType<typeof buildOrderRequest>, jwt: string): Promise<OrderResponse>;
  buildDepositTx(req: {
    wallet: string;
    profileIndex: number;
    amount: number;
    mode: "deposit" | "withdraw";
  }): Promise<DepositResponse>;
  syncProfileSweep(wallet: string, profileIndex: number): Promise<SyncSweepResponse>;
}

export type FlowStepName =
  | "deposit"
  | "deposit-confirm"
  | "order"
  | "close"
  | "settle"
  | "sweep"
  | "withdraw"
  | "withdraw-confirm"
  | "done";

export interface FlowProgress {
  step: FlowStepName;
  message: string;
  signature?: string;
}

/** RPC confirmation primitive (best-effort fast signal; balances are authoritative). */
export type ConfirmFn = (signature: string) => Promise<void>;

export interface FlowDeps {
  signer: SignerProvider;
  jwt: string;
  /**
   * Ordered venues to attempt the open on (from `marketVenueCandidates`). The
   * deposit happens once; the order is tried on each venue until one fills.
   * Defaults to `[input.venue]` when omitted.
   */
  venues?: VenueTag[];
  confirm?: ConfirmFn;
  onStep?: (p: FlowProgress) => void;
  /** Throws a human error if the wallet can't cover the deposit (gas / USDC). */
  assertDepositReady?: (depositNative: number) => Promise<void>;
  api?: FlowApi;
  pollIntervalMs?: number;
  settleTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Delay before retrying a venue once on a transient market-cache miss. Default 2500ms. */
  resolveRetryMs?: number;
  /** Max placement attempts per venue when the order is rejected retryably. Default 3. */
  orderRetries?: number;
  /** Delay between retryable placement attempts. Default 1200ms. */
  orderRetryMs?: number;
}

/**
 * Recoverable trade-flow failure — funds are always safe in the profile.
 *   - `depositedNative`: a deposit landed before the open was rejected.
 *   - `closed`: the position WAS closed but the subsequent withdrawal didn't go
 *     through (e.g. user rejected the wallet popup) — funds sit in the profile.
 */
export class TradeFlowError extends Error {
  constructor(
    message: string,
    public readonly depositedNative = 0,
    public readonly closed = false
  ) {
    super(message);
    this.name = "TradeFlowError";
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntil(
  pred: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await pred()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

// ───────────────────────────────────────────────────────────── open

export interface OpenResult {
  depositedNative: number;
  order: OrderResponse;
  /** The venue the order actually filled on. */
  venue: VenueTag;
}

/**
 * Fund the profile (if needed) then open the position — one wallet signature.
 * The order is attempted across `deps.venues` (cost-ordered, Phoenix excluded for
 * market) until one fills; only if all reject does it throw TradeFlowError
 * (carrying any deposited amount — funds remain safe in the profile).
 */
export async function openWithDeposit(input: OrderFormInput, deps: FlowDeps): Promise<OpenResult> {
  const api = deps.api ?? defaultImperial;
  const sleep = deps.sleep ?? realSleep;
  const interval = deps.pollIntervalMs ?? 2500;
  const settleTimeout = deps.settleTimeoutMs ?? 45_000;
  const step = deps.onStep ?? (() => {});

  const venues = deps.venues && deps.venues.length ? deps.venues : [input.venue];

  const requiredNative = toUsdFixed(input.collateralUsd);

  const balances = await api.getBalances(deps.jwt);
  const free = profileFree(balances, input.profileIndex);
  const depositNative = depositShortfallNative(input.collateralUsd, free);

  let depositedNative = 0;
  if (depositNative > 0) {
    if (deps.assertDepositReady) await deps.assertDepositReady(depositNative);
    step({ step: "deposit", message: `Depositing $${(depositNative / 1e6).toFixed(2)} to profile ${input.profileIndex}…` });
    const { transaction } = await api.buildDepositTx({
      wallet: input.wallet,
      profileIndex: input.profileIndex,
      amount: depositNative,
      mode: "deposit",
    });
    const { signature } = await deps.signer.signAndSendTransaction({
      kind: "solana-versioned",
      base64: transaction,
    });
    depositedNative = depositNative;
    step({ step: "deposit-confirm", message: "Confirming deposit…", signature });
    if (deps.confirm) await deps.confirm(signature).catch(() => {});
    // Gate the order on the funds actually landing in the profile (Imperial
    // reads the on-chain ATA — authoritative even if the RPC confirm is slow).
    const landed = await pollUntil(
      async () => profileFree(await api.getBalances(deps.jwt), input.profileIndex) >= requiredNative,
      settleTimeout,
      interval,
      sleep
    );
    if (!landed) {
      throw new TradeFlowError(
        `Deposit of $${(depositNative / 1e6).toFixed(2)} didn't settle in time — funds are in profile ${input.profileIndex}. Retry shortly.`,
        depositedNative
      );
    }
  }

  // Attempt the order across the candidate venues until one fills. A rejected
  // order opens no position (no charge), so falling through is cheap; the
  // deposit already landed and is venue-agnostic, so we never re-deposit.
  //
  // Per venue we retry on two recoverable rejections before falling through:
  //   • a transient market-cache miss (Flash V2's runtime-warmed market list not
  //     yet hydrated on the serving instance) — waits `resolveRetryMs`;
  //   • a transient placement failure ("Failed to place order — please try
  //     again", common on the high-leverage path) — waits `orderRetryMs`.
  // A hard rejection (insufficient margin, max leverage, invalid market) matches
  // neither and falls through immediately.
  const maxAttempts = Math.max(1, deps.orderRetries ?? 3);
  let lastError = "unknown";
  for (let i = 0; i < venues.length; i += 1) {
    const v = venues[i];
    const req = buildOrderRequest({ ...input, venue: v });
    const where = venues.length > 1 ? ` (${i + 1}/${venues.length})` : "";
    let order = { success: false } as OrderResponse;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      step({
        step: "order",
        message:
          attempt === 1
            ? `Opening ${input.side} ${input.symbol} on ${v}${where}…`
            : `${v} busy — retry ${attempt}/${maxAttempts}…`,
      });
      order = await api.placeOrder(req, deps.jwt);
      if (order.success) break;
      const resolveMiss = isTransientResolveError(order.error);
      const retryable = resolveMiss || isRetryableOrderError(order.error);
      if (!retryable || attempt === maxAttempts) break;
      await sleep(resolveMiss ? deps.resolveRetryMs ?? 2500 : deps.orderRetryMs ?? 1200);
    }
    if (order.success) {
      step({ step: "done", message: `Position opened on ${v}.`, signature: order.signature ?? undefined });
      return { depositedNative, order, venue: v };
    }
    lastError = order.error ?? "unknown";
  }

  throw new TradeFlowError(
    depositedNative > 0
      ? `Deposited $${(depositedNative / 1e6).toFixed(2)} to profile ${input.profileIndex}, but the order was rejected on ${venues.join(", ")}: ${lastError}. Funds are safe — retry or withdraw.`
      : `Order rejected on ${venues.join(", ")}: ${lastError}.`,
    depositedNative
  );
}

// ───────────────────────────────────────────────────────────── close

export interface CloseParams {
  wallet: string;
  profileIndex: number;
  symbol: string;
  venue: OrderFormInput["venue"];
  positionSide: "long" | "short";
  sizeUsd: number;
  markPrice: number;
  slippageBps: number;
}

export interface CloseResult {
  close: OrderResponse;
  sweep: SyncSweepResponse | null;
  withdrawnNative: number;
  withdrawSignature?: string;
}

/**
 * Close the full position then withdraw the profile's entire free balance back
 * to the wallet — one wallet signature (the withdraw). The close runs on the
 * order bot (no signature). If the close succeeds but the withdraw fails, funds
 * are safe in the profile and the error says so.
 */
export async function closeAndWithdraw(params: CloseParams, deps: FlowDeps): Promise<CloseResult> {
  const api = deps.api ?? defaultImperial;
  const sleep = deps.sleep ?? realSleep;
  const interval = deps.pollIntervalMs ?? 2500;
  const settleTimeout = deps.settleTimeoutMs ?? 45_000;
  const step = deps.onStep ?? (() => {});

  const preCloseFree = profileFree(await api.getBalances(deps.jwt), params.profileIndex);

  step({ step: "close", message: `Closing ${params.symbol} — no signature needed…` });
  const close = await api.placeOrder(
    buildCloseRequest({
      wallet: params.wallet,
      profileIndex: params.profileIndex,
      symbol: params.symbol,
      venue: params.venue,
      positionSide: params.positionSide,
      sizeUsd: params.sizeUsd,
      markPrice: params.markPrice,
      slippageBps: params.slippageBps,
    }),
    deps.jwt
  );
  if (!close.success) throw new TradeFlowError(`Close rejected: ${close.error ?? "unknown"}.`);

  // Wait for collateral + realized PnL − fees to settle into the profile's free
  // USDC (best-effort; proceed at timeout and withdraw whatever's free).
  step({ step: "settle", message: "Settling proceeds…" });
  await pollUntil(
    async () => profileFree(await api.getBalances(deps.jwt), params.profileIndex) > preCloseFree,
    settleTimeout,
    interval,
    sleep
  );

  // Sweep any non-USDC residue (WSOL/WBTC/WETH) back to USDC for token-collateral
  // venues; "clean" no-op for USDC venues.
  step({ step: "sweep", message: "Sweeping residual collateral…" });
  let sweep: SyncSweepResponse | null = null;
  try {
    sweep = await api.syncProfileSweep(params.wallet, params.profileIndex);
    if (sweep?.status === "swept") {
      await pollUntil(
        async () => profileFree(await api.getBalances(deps.jwt), params.profileIndex) > preCloseFree,
        settleTimeout,
        interval,
        sleep
      );
    }
  } catch {
    /* sweep is best-effort */
  }

  const withdrawNative = profileFree(await api.getBalances(deps.jwt), params.profileIndex);
  let withdrawSignature: string | undefined;
  if (withdrawNative > 0) {
    step({
      step: "withdraw",
      message: `Closed. Approve the wallet popup to withdraw $${(withdrawNative / 1e6).toFixed(2)} to your wallet…`,
    });
    const { transaction } = await api.buildDepositTx({
      wallet: params.wallet,
      profileIndex: params.profileIndex,
      amount: withdrawNative,
      mode: "withdraw",
    });
    try {
      const res = await deps.signer.signAndSendTransaction({ kind: "solana-versioned", base64: transaction });
      withdrawSignature = res.signature;
      step({ step: "withdraw-confirm", message: "Confirming withdrawal…", signature: withdrawSignature });
      if (deps.confirm) await deps.confirm(withdrawSignature).catch(() => {});
    } catch {
      // The position is already closed; only the withdrawal didn't go through.
      // Flag `closed` so the UI shows a calm note, not a hard error.
      throw new TradeFlowError(
        `${params.symbol} closed. Withdrawal cancelled — $${(withdrawNative / 1e6).toFixed(2)} is safe in profile ${params.profileIndex}; withdraw anytime.`,
        0,
        true
      );
    }
  }

  step({ step: "done", message: "Closed and withdrawn.", signature: withdrawSignature });
  return { close, sweep, withdrawnNative: withdrawNative, withdrawSignature };
}
