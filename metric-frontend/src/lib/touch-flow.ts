"use client";

/**
 * Orchestrated one-action Imperial Touch flows (underwriter 6) — the MONEY PATH.
 *
 * Mirrors trade-flow's `openWithDeposit` and reuses its exported helpers
 * (`depositShortfallNative`, `pollUntil`, `placeOrderWithRetry`, `TradeFlowError`)
 * so the deposit + settle-gate + retry-classification logic can never drift.
 *
 * Touch is NOT a perp venue — it reuses the perp `OrderRequest` record with heavy
 * FIELD OVERLOADING (see `buildTouchOpenRequest` / `buildTouchCloseRequest` in
 * touch-order.ts, which the A step added). Because touch is underwriter 6 and NOT
 * flash_v2, its collateral never surfaces in the Flash V2 UserDepositLedger — so
 * the settle gate here counts PROFILE-FREE USDC ONLY (do not use the V2 ledger).
 *
 * Imperial executes the buy/sell-back on its delegated order bot (server-side, no
 * client signature) — only deposit/withdraw are client-signed. So a single atomic
 * Solana tx is impossible; the two halves are sequenced so the user signs exactly
 * ONCE per direction:
 *
 *   open   : [maybe] deposit the premium budget (1 wallet sig, also creates the
 *            account on first use) → wait for funds to land → buy ONCE (bot, no
 *            sig) with the user's exact barrier/budget. On TouchQuoteMoved the
 *            live ask jumped above the budget → surface a clear "refresh the
 *            quote" error (fresh user consent needed); the deposit stays safe.
 *   close  : sell back the position (bot, no sig). No deposit, no signature.
 *   claim  : withdraw the profile's free USDC to the wallet (1 wallet sig) — the
 *            keeper settles proceeds into profile-free USDC automatically at
 *            expiry / on a barrier sweep; this just sweeps it home.
 *
 * Like trade-flow this module is decoupled from React/web3: it takes an injectable
 * Imperial client (`TouchFlowApi`), signer, optional RPC `confirm`, and `onStep`
 * reporter, so it is unit-testable and the SignerProvider interface is unchanged.
 */

import { imperial as defaultImperial } from "@/lib/imperial";
import type { DepositResponse, OrderResponse, BalancesResponse } from "@/lib/imperial/types";
import type { SignerProvider } from "@/lib/wallet/types";
import {
  buildTouchCloseRequest,
  buildTouchOpenRequest,
  type TouchCloseParams,
} from "@/lib/touch-order";
import {
  depositShortfallNative,
  pollUntil,
  placeOrderWithRetry,
  realSleep,
  TradeFlowError,
} from "@/lib/trade-flow";

/**
 * Dedicated isolated profile for touch so touch USDC never commingles with perp
 * margin (profiles 0..5 are isolated, created lazily on first deposit). The degen
 * game uses its own profile for the same reason.
 */
export const TOUCH_PROFILE = 4;

/**
 * Fraction of a deposit that must land in profile-free USDC before the settle gate
 * passes (fee/rounding slack). Matches trade-flow's SETTLE_DELTA_FRACTION.
 */
const SETTLE_DELTA_FRACTION = 0.97;

// ───────────────────────────────────────────────────────────── error classification

/**
 * True when the buy was rejected because the live ask outran the premium budget
 * (`TouchQuoteMoved`). The 100bps slack in `touchPremiumBudget` already absorbs
 * normal drift, so a >budget jump means the user must re-consent at the new price:
 * the open surfaces a clear "refresh the quote" error rather than silently buying
 * at a higher budget. (The sell-back path still retries it in place.)
 */
export function isTouchQuoteMoved(error: string | null | undefined): boolean {
  if (!error) return false;
  return /touchquotemoved|quote\s?moved/i.test(error);
}

/**
 * True when a sell-back rejection is TERMINAL (do NOT retry): the barrier was
 * swept (`TouchBarrierSwept`), the position settles only at expiry
 * (`TouchSettlesAtExpiry`), or it is already closed (`PositionAlreadyClosed`).
 * These describe a state change that re-placing the same order can never fix, so
 * they must map to a clear terminal error rather than loop.
 */
export function isTerminalCloseError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /touchbarrierswept|barrier\s?swept|touchsettlesatexpiry|settles?\s?at\s?expiry|positionalreadyclosed|already\s?closed/i.test(
    error
  );
}

/** Humanize a terminal close rejection for the UI. */
function terminalCloseMessage(error: string | null | undefined): string {
  const e = error ?? "";
  if (/touchbarrierswept|barrier\s?swept/i.test(e))
    return "The barrier was swept — this position now settles automatically. Nothing to sell back.";
  if (/touchsettlesatexpiry|settles?\s?at\s?expiry/i.test(e))
    return "This position can't be sold back — it settles at expiry. Wait for it to settle.";
  if (/positionalreadyclosed|already\s?closed/i.test(e))
    return "This position is already closed.";
  return `Sell-back rejected: ${error ?? "unknown"}.`;
}

// ───────────────────────────────────────────────────────────── deps + api

/** Subset of the Imperial client the touch flow needs (injectable for tests). */
export interface TouchFlowApi {
  getBalances(jwt: string): Promise<BalancesResponse>;
  placeOrder(req: ReturnType<typeof buildTouchOpenRequest>, jwt: string): Promise<OrderResponse>;
  buildDepositTx(req: {
    wallet: string;
    profileIndex: number;
    amount: number;
    mode: "deposit" | "withdraw";
  }): Promise<DepositResponse>;
}

/** RPC confirmation primitive (best-effort; balances/positions are authoritative). */
export type ConfirmFn = (signature: string) => Promise<void>;

export type TouchStepName =
  | "deposit"
  | "deposit-confirm"
  | "settle"
  | "order"
  | "close"
  | "withdraw"
  | "withdraw-confirm"
  | "done";

export interface TouchProgress {
  step: TouchStepName;
  message: string;
  signature?: string;
}

export interface TouchFlowDeps {
  signer: SignerProvider;
  jwt: string;
  confirm?: ConfirmFn;
  onStep?: (p: TouchProgress) => void;
  api?: TouchFlowApi;
  pollIntervalMs?: number;
  settleTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Max sell-back attempts across TouchQuoteMoved retries. Default 3. (The OPEN
   * path places exactly once — a >budget jump needs fresh user consent — so this
   * applies only to {@link sellBackTouch}.)
   */
  quoteRetries?: number;
  /** Delay between a rejected sell-back and the retry. Default 1200ms. */
  requoteMs?: number;
  /** Throws a human error if the wallet can't cover the deposit (gas / USDC). */
  assertDepositReady?: (depositNative: number) => Promise<void>;
}

function profileFree(balances: BalancesResponse, profileIndex: number): number {
  return balances.profiles.find((p) => p.profileIndex === profileIndex)?.usdc ?? 0;
}

// ───────────────────────────────────────────────────────────── open (buy)

export interface OpenTouchInput {
  wallet: string;
  profileIndex: number;
  /** Touch family symbol, e.g. "SOLTOUCH" (24h tenor when no marketMint). */
  symbol: string;
  /**
   * Market PDA for a specific tenor. Prefer when present; a bare symbol resolves
   * server-side to the LOWEST marketId = the 24h tenor.
   * TODO(imperial): expose the 1h/5m market PDAs so non-24h tenors can be traded.
   */
  marketMint?: string | null;
  /** true = Touch (pays if spot reaches the barrier before expiry); false = No-Touch. */
  isTouch: boolean;
  /** Barrier price, 1e9 oracle scale (from a TouchDealRow.barrier1e9). */
  barrier1e9: number;
  /** Payout, µUSD (within config.minPayoutUsd..maxPayoutUsd). Sent as sizeUsd. */
  payoutUsd: number;
  /** Max premium you'll pay, µUSD (see touchPremiumBudget). Sent as collateralAmount. */
  premiumBudgetUsd: number;
}

export interface OpenTouchResult {
  depositedNative: number;
  order: OrderResponse;
  /** The barrier the fill was placed against — always the user's exact input. */
  barrier1e9: number;
  /** The premium budget the fill was placed with — always the user's exact input. */
  premiumBudgetUsd: number;
}

/**
 * Fund the touch profile (if needed) then buy the touch position — one wallet
 * signature (the deposit). The buy runs on Imperial's order bot (no signature).
 *
 * Settle gate: touch is underwriter 6 (NOT flash_v2), so proceeds/collateral live
 * in PROFILE-FREE USDC only — the gate waits on profile-free, never the V2 ledger.
 *
 * SINGLE placement — the buy is the user's EXACT `barrier1e9` and
 * `premiumBudgetUsd`, placed once (no requote loop, no barrier substitution). The
 * 100bps slack baked into `touchPremiumBudget` already absorbs normal ask drift;
 * a `TouchQuoteMoved` means the ask jumped ABOVE the stated budget, which needs
 * fresh user consent at the new price — silently escalating the budget would both
 * exceed the user's max AND require a second signature to fund. So we surface a
 * clear "refresh the quote" error instead. Any deposited funds stay in the profile
 * and are reused on the next try (the deposit only sizes the shortfall).
 */
export async function openTouchWithDeposit(
  input: OpenTouchInput,
  deps: TouchFlowDeps
): Promise<OpenTouchResult> {
  const api = deps.api ?? defaultImperial;
  const sleep = deps.sleep ?? realSleep;
  const interval = deps.pollIntervalMs ?? 2500;
  const settleTimeout = deps.settleTimeoutMs ?? 45_000;
  const step = deps.onStep ?? (() => {});

  const budgetNative = input.premiumBudgetUsd;

  // Read profile-free USDC and deposit only the shortfall so the profile can cover
  // the full premium budget (the fill debits the true ask and refunds the rest).
  const free = profileFree(await api.getBalances(deps.jwt), input.profileIndex);
  const depositNative = depositShortfallNative(budgetNative / 1e6, free);

  let depositedNative = 0;
  if (depositNative > 0) {
    if (deps.assertDepositReady) await deps.assertDepositReady(depositNative);
    step({
      step: "deposit",
      message: `Depositing $${(depositNative / 1e6).toFixed(2)} to profile ${input.profileIndex}…`,
    });
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
    // Best-effort RPC confirm — the balance poll below is authoritative, so DON'T
    // await it (a slow/forbidden confirm would add up to 30s to every open).
    if (deps.confirm) void deps.confirm(signature).catch(() => {});
    step({ step: "settle", message: "Waiting for deposit to settle…", signature });
    // Gate the buy on the deposit landing in PROFILE-FREE USDC (underwriter 6 → no
    // V2 ledger). Delta target off the pre-deposit free balance so it doesn't pass
    // prematurely if the profile already held a little.
    const target = free + depositNative * SETTLE_DELTA_FRACTION;
    const landed = await pollUntil(
      async () => profileFree(await api.getBalances(deps.jwt), input.profileIndex) >= target,
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

  // SINGLE placement with the user's EXACT barrier + budget — never substituted or
  // escalated. maxAttempts:1 so placeOrderWithRetry's generic transient retry never
  // fires (touch has no transient-resolve class); a rejection is surfaced verbatim.
  const req = buildTouchOpenRequest({
    wallet: input.wallet,
    profileIndex: input.profileIndex,
    symbol: input.symbol,
    marketMint: input.marketMint,
    isTouch: input.isTouch,
    barrier1e9: input.barrier1e9,
    payoutUsd: input.payoutUsd,
    premiumBudgetUsd: input.premiumBudgetUsd,
  });
  step({
    step: "order",
    message: `Placing ${input.isTouch ? "Touch" : "No-Touch"} ${input.symbol}…`,
  });
  const order = await placeOrderWithRetry(() => api.placeOrder(req, deps.jwt), {
    maxAttempts: 1,
    resolveRetryMs: 0,
    orderRetryMs: 0,
    sleep,
  });
  if (order.success) {
    step({ step: "done", message: `Position opened.`, signature: order.signature ?? undefined });
    return {
      depositedNative,
      order,
      barrier1e9: input.barrier1e9,
      premiumBudgetUsd: input.premiumBudgetUsd,
    };
  }

  const err = order.error ?? "unknown";
  const fundsSafe =
    depositedNative > 0
      ? ` Funds are safe in profile ${input.profileIndex} (reused on your next try).`
      : "";
  // On TouchQuoteMoved the ask jumped above the stated budget — a >budget move
  // needs fresh user consent (the 100bps slack already covers normal drift), so we
  // don't escalate/re-fund; the deposited funds stay put and size only the
  // shortfall next time. Any other rejection is surfaced verbatim.
  const message = isTouchQuoteMoved(err)
    ? `The premium moved above your $${(input.premiumBudgetUsd / 1e6).toFixed(2)} budget — refresh the quote and try again.${fundsSafe}`
    : `Touch buy rejected: ${err}.`;
  throw new TradeFlowError(message, depositedNative);
}

// ───────────────────────────────────────────────────────────── sell back (early close)

export interface SellBackTouchParams {
  wallet: string;
  profileIndex: number;
  symbol: string;
  marketMint?: string | null;
  /** Position id from /touch/positions (from 0). */
  positionId: number;
  /** The position's payoutUsd echoed BYTE-FOR-BYTE from /touch/positions (µUSD). */
  payoutUsd: number;
  /** Minimum-refund floor, µUSD (0 = accept any bid). */
  minRefundUsd: number;
}

export interface SellBackTouchResult {
  order: OrderResponse;
}

/**
 * Sell back (early close) a touch position — POST /mobile/orders on the order bot
 * (NO signature). TouchQuoteMoved is retried in-place; TouchBarrierSwept /
 * TouchSettlesAtExpiry / PositionAlreadyClosed map to CLEAR TERMINAL errors (no
 * retry) — they describe a state change that re-placing can never fix.
 */
export async function sellBackTouch(
  params: SellBackTouchParams,
  deps: TouchFlowDeps
): Promise<SellBackTouchResult> {
  const api = deps.api ?? defaultImperial;
  const sleep = deps.sleep ?? realSleep;
  const step = deps.onStep ?? (() => {});
  const maxAttempts = Math.max(1, deps.quoteRetries ?? 3);
  const requoteMs = deps.requoteMs ?? 1200;

  const closeReq: TouchCloseParams = {
    wallet: params.wallet,
    profileIndex: params.profileIndex,
    symbol: params.symbol,
    marketMint: params.marketMint,
    positionId: params.positionId,
    payoutUsd: params.payoutUsd,
    minRefundUsd: params.minRefundUsd,
  };
  const req = buildTouchCloseRequest(closeReq);

  step({ step: "close", message: `Selling back ${params.symbol} — no signature needed…` });

  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      step({ step: "close", message: `Quote moved — retry ${attempt}/${maxAttempts}…` });
    }
    const order = await api.placeOrder(req, deps.jwt);
    if (order.success) {
      step({ step: "done", message: "Sold back.", signature: order.signature ?? undefined });
      return { order };
    }
    lastError = order.error ?? "unknown";

    // Terminal state change — do NOT loop; surface a clear error.
    if (isTerminalCloseError(lastError)) {
      throw new TradeFlowError(terminalCloseMessage(lastError));
    }
    // Only TouchQuoteMoved is retryable on a sell-back; anything else is terminal.
    if (!isTouchQuoteMoved(lastError) || attempt === maxAttempts) break;
    await sleep(requoteMs);
  }

  throw new TradeFlowError(`Sell-back rejected: ${lastError}.`);
}

// ───────────────────────────────────────────────────────────── claim (withdraw)

export interface ClaimTouchParams {
  wallet: string;
  profileIndex: number;
}

export interface ClaimTouchResult {
  withdrawnNative: number;
  signature?: string;
}

/**
 * Withdraw the touch profile's entire free USDC balance back to the wallet — one
 * wallet signature. The keeper settles proceeds into profile-free USDC
 * automatically at expiry / on a barrier sweep (no residue sweep), so this just
 * sweeps the settled proceeds home. Mirrors the degen game's claim exactly.
 */
export async function claimTouch(
  params: ClaimTouchParams,
  deps: TouchFlowDeps
): Promise<ClaimTouchResult> {
  const api = deps.api ?? defaultImperial;
  const step = deps.onStep ?? (() => {});

  const withdrawNative = profileFree(await api.getBalances(deps.jwt), params.profileIndex);
  if (!(withdrawNative > 0)) {
    step({ step: "done", message: "Nothing to claim." });
    return { withdrawnNative: 0 };
  }

  step({
    step: "withdraw",
    message: `Approve the wallet popup to withdraw $${(withdrawNative / 1e6).toFixed(2)} to your wallet…`,
  });
  const { transaction } = await api.buildDepositTx({
    wallet: params.wallet,
    profileIndex: params.profileIndex,
    amount: withdrawNative,
    mode: "withdraw",
  });
  const { signature } = await deps.signer.signAndSendTransaction({
    kind: "solana-versioned",
    base64: transaction,
  });
  step({ step: "withdraw-confirm", message: "Confirming withdrawal…", signature });
  // Fire-and-forget RPC confirm — the withdraw is already submitted (mirrors degen).
  if (deps.confirm) void deps.confirm(signature).catch(() => {});
  step({ step: "done", message: "Claimed to wallet.", signature });
  return { withdrawnNative: withdrawNative, signature };
}
