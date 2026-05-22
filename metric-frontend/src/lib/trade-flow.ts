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
 * and is order-type-blind — it can return Phoenix, which is a CLOB and rejects
 * market orders. So for market orders we drop Phoenix and keep the remaining
 * route candidates in cost order; the caller tries them in turn until one fills.
 *
 *  - market: route candidates with `!filteredReason && venue !== "phoenix"`, in
 *    order; if the user explicitly picked a viable non-Phoenix venue, it goes
 *    first. Empty array ⇒ no market-capable venue (e.g. a Phoenix-only synthetic)
 *    so the caller should not deposit and should suggest a limit order. If /route
 *    is unavailable, falls back to the selected non-Phoenix venue or GMTrade.
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
    // Route unavailable — best effort. Honor an explicit non-Phoenix pick, else GMTrade.
    return [selectedVenue !== "auto" && selectedVenue !== "phoenix" ? selectedVenue : "gmtrade"];
  }
  const viable = cands.filter((c) => !c.filteredReason && c.venue !== "phoenix").map((c) => c.venue);
  if (viable.length === 0) return []; // Phoenix-only asset → market unsupported here
  let ordered = viable;
  if (selectedVenue !== "auto" && selectedVenue !== "phoenix" && viable.includes(selectedVenue)) {
    ordered = [selectedVenue, ...viable.filter((v) => v !== selectedVenue)];
  }
  return [...new Set(ordered)];
}

function profileFree(balances: BalancesResponse, profileIndex: number): number {
  return balances.profiles.find((p) => p.profileIndex === profileIndex)?.usdc ?? 0;
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
}

/** Order rejected after a deposit already landed — funds are safe in the profile. */
export class TradeFlowError extends Error {
  constructor(message: string, public readonly depositedNative = 0) {
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
  let lastError = "unknown";
  for (let i = 0; i < venues.length; i += 1) {
    const v = venues[i];
    step({
      step: "order",
      message:
        venues.length > 1
          ? `Opening ${input.side} ${input.symbol} on ${v} (${i + 1}/${venues.length})…`
          : `Opening ${input.side} ${input.symbol} on ${v}…`,
    });
    const order = await api.placeOrder(buildOrderRequest({ ...input, venue: v }), deps.jwt);
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

  step({ step: "close", message: `Closing ${params.symbol}…` });
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
    step({ step: "withdraw", message: `Withdrawing $${(withdrawNative / 1e6).toFixed(2)} to wallet…` });
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
    } catch (e) {
      throw new TradeFlowError(
        `Closed ${params.symbol}, but the withdrawal failed: ${e instanceof Error ? e.message : String(e)}. Funds are safe in profile ${params.profileIndex} — retry the withdrawal.`
      );
    }
  }

  step({ step: "done", message: "Closed and withdrawn.", signature: withdrawSignature });
  return { close, sweep, withdrawnNative: withdrawNative, withdrawSignature };
}
