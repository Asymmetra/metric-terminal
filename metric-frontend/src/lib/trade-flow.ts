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
 * USDC (native, 6-dec) to deposit so the profile can fund `collateralUsd`,
 * given its current free balance. Tops up to `collateral + feeBuffer`; returns
 * 0 when already covered.
 */
export function depositShortfallNative(
  collateralUsd: number,
  feeBufferUsd: number,
  profileFreeNative: number
): number {
  const targetNative = toUsdFixed(collateralUsd) + toUsdFixed(feeBufferUsd);
  return Math.max(0, targetNative - profileFreeNative);
}

/**
 * Small USD cushion added to the deposit (not to collateral) so an open fee
 * debited at open can't underfund the profile. Uses the route's open
 * fee+slippage estimate when available; otherwise a flat 1% of collateral.
 */
export function feeBufferUsd(collateralUsd: number, route?: RouteResponse | null): number {
  if (route?.costBreakdown) {
    const { openFee, openSlip } = route.costBreakdown;
    const buf = (Number(openFee) || 0) + (Number(openSlip) || 0);
    if (buf > 0) return buf;
  }
  return collateralUsd * 0.01;
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
  /** Pre-fetched route for the order, used only to size the deposit fee buffer. */
  route?: RouteResponse | null;
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
}

/**
 * Fund the profile (if needed) then open the position — one wallet signature.
 * Throws TradeFlowError (carrying any deposited amount) on order rejection.
 */
export async function openWithDeposit(input: OrderFormInput, deps: FlowDeps): Promise<OpenResult> {
  const api = deps.api ?? defaultImperial;
  const sleep = deps.sleep ?? realSleep;
  const interval = deps.pollIntervalMs ?? 2500;
  const settleTimeout = deps.settleTimeoutMs ?? 45_000;
  const step = deps.onStep ?? (() => {});

  const requiredNative = toUsdFixed(input.collateralUsd);
  const buffer = feeBufferUsd(input.collateralUsd, deps.route);

  const balances = await api.getBalances(deps.jwt);
  const free = profileFree(balances, input.profileIndex);
  const depositNative = depositShortfallNative(input.collateralUsd, buffer, free);

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

  step({ step: "order", message: `Opening ${input.side} ${input.symbol}…` });
  const order = await api.placeOrder(buildOrderRequest(input), deps.jwt);
  if (!order.success) {
    throw new TradeFlowError(
      depositedNative > 0
        ? `Deposited $${(depositedNative / 1e6).toFixed(2)} to profile ${input.profileIndex}, but the order was rejected: ${order.error ?? "unknown"}. Funds are safe — retry or withdraw.`
        : `Order rejected: ${order.error ?? "unknown"}.`,
      depositedNative
    );
  }
  step({ step: "done", message: "Position opened.", signature: order.signature ?? undefined });
  return { depositedNative, order };
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
