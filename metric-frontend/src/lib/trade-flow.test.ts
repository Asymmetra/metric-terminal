import { describe, expect, it, vi } from "vitest";
import {
  depositShortfallNative,
  feeBufferUsd,
  openWithDeposit,
  closeAndWithdraw,
  TradeFlowError,
  type FlowApi,
  type FlowDeps,
} from "./trade-flow";
import type { BalancesResponse, OrderResponse, SyncSweepResponse } from "./imperial/types";
import type { OrderFormInput } from "./order-builder";

// ───────────────────────────── pure math

describe("trade-flow math", () => {
  it("depositShortfallNative tops up to collateral + buffer", () => {
    expect(depositShortfallNative(10, 0.1, 0)).toBe(10_100_000);
    expect(depositShortfallNative(10, 0.1, 5_000_000)).toBe(5_100_000);
  });
  it("depositShortfallNative is 0 when already funded", () => {
    expect(depositShortfallNative(10, 0.1, 10_100_000)).toBe(0);
    expect(depositShortfallNative(10, 0.1, 50_000_000)).toBe(0);
  });
  it("feeBufferUsd prefers route open fee+slip, else 1%", () => {
    expect(feeBufferUsd(100, null)).toBeCloseTo(1, 6);
    const route = { costBreakdown: { openFee: 0.3, openSlip: 0.2 } } as never;
    expect(feeBufferUsd(100, route)).toBeCloseTo(0.5, 6);
  });
});

// ───────────────────────────── fakes

const ORDER_OK: OrderResponse = { success: true, signature: "ordsig", orderPda: null, error: null };

function balances(free: number): BalancesResponse {
  return {
    wallet: "W",
    profiles: [0, 1, 2, 3, 4, 5].map((i) => ({
      profileIndex: i,
      profilePda: `pda${i}`,
      usdc: i === 0 ? free : 0,
    })),
  };
}

/** Mutable-balance fake Imperial API + recording. */
function makeApi(opts: {
  startFree: number;
  onDeposit?: (amount: number) => void; // mutate free to simulate landing
  onOrder?: () => OrderResponse; // override order outcome
  onClose?: () => void; // mutate free to simulate proceeds
  sweepStatus?: SyncSweepResponse["status"];
}) {
  let free = opts.startFree;
  const calls = { buildDeposit: [] as { amount: number; mode: string }[], orders: 0, sweeps: 0 };
  const api: FlowApi = {
    async getBalances() {
      return balances(free);
    },
    async placeOrder(req) {
      calls.orders += 1;
      if (req.action === 1) {
        // Decrease (close)
        opts.onClose?.();
        return ORDER_OK;
      }
      return opts.onOrder ? opts.onOrder() : ORDER_OK;
    },
    async buildDepositTx(req) {
      calls.buildDeposit.push({ amount: req.amount, mode: req.mode });
      if (req.mode === "deposit") opts.onDeposit?.(req.amount);
      if (req.mode === "withdraw") free -= req.amount;
      return { transaction: "BASE64TX" };
    },
    async syncProfileSweep() {
      calls.sweeps += 1;
      return { status: opts.sweepStatus ?? "clean", message: "ok", balances: null };
    },
  };
  return {
    api,
    calls,
    setFree: (v: number) => (free = v),
    getFree: () => free,
  };
}

function makeSigner(onSign?: () => void) {
  return {
    publicKey: "W",
    isReady: true,
    displayName: "Test",
    async signMessage() {
      return { signatureBase58: "msgsig" };
    },
    async signAndSendTransaction() {
      onSign?.();
      return { signature: "txsig" };
    },
  };
}

const baseInput: OrderFormInput = {
  wallet: "W",
  profileIndex: 0,
  symbol: "SOL",
  venue: "phoenix",
  side: "long",
  type: "market",
  sizeUsd: 20,
  collateralUsd: 10,
  markPrice: 150,
  slippageBps: 200,
};

const fastDeps = (extra: Partial<FlowDeps>): FlowDeps => ({
  signer: makeSigner(),
  jwt: "jwt",
  pollIntervalMs: 0,
  settleTimeoutMs: 1000,
  sleep: async () => {},
  ...extra,
});

// ───────────────────────────── open

describe("openWithDeposit", () => {
  it("deposits the shortfall, waits for funds, then opens", async () => {
    const f = makeApi({ startFree: 0, onDeposit: (amt) => f.setFree(amt) });
    const onStep = vi.fn();
    const res = await openWithDeposit(baseInput, fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_100_000)), onStep }));
    expect(f.calls.buildDeposit).toEqual([{ amount: 10_100_000, mode: "deposit" }]);
    expect(res.depositedNative).toBe(10_100_000);
    expect(res.order.success).toBe(true);
    expect(onStep.mock.calls.map((c) => c[0].step)).toContain("done");
  });

  it("skips the deposit when the profile is already funded", async () => {
    const f = makeApi({ startFree: 20_000_000 });
    const signer = makeSigner(vi.fn());
    const res = await openWithDeposit(baseInput, fastDeps({ api: f.api, signer }));
    expect(f.calls.buildDeposit).toEqual([]);
    expect(res.depositedNative).toBe(0);
    expect(res.order.success).toBe(true);
  });

  it("throws TradeFlowError carrying the deposit when the order is rejected", async () => {
    const f = makeApi({
      startFree: 0,
      onDeposit: (amt) => f.setFree(amt),
      onOrder: () => ({ success: false, signature: null, orderPda: null, error: "slippage exceeded" }),
    });
    await expect(
      openWithDeposit(baseInput, fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_100_000)) }))
    ).rejects.toMatchObject({ name: "TradeFlowError", depositedNative: 10_100_000 });
  });

  it("calls assertDepositReady before depositing", async () => {
    const f = makeApi({ startFree: 0, onDeposit: (amt) => f.setFree(amt) });
    const assertDepositReady = vi.fn(async () => {});
    await openWithDeposit(
      baseInput,
      fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_100_000)), assertDepositReady })
    );
    expect(assertDepositReady).toHaveBeenCalledWith(10_100_000);
  });
});

// ───────────────────────────── close

describe("closeAndWithdraw", () => {
  const closeParams = {
    wallet: "W",
    profileIndex: 0,
    symbol: "SOL",
    venue: "phoenix" as const,
    positionSide: "long" as const,
    sizeUsd: 20,
    markPrice: 150,
    slippageBps: 200,
  };

  it("closes, settles, then withdraws the full free balance", async () => {
    const f = makeApi({ startFree: 0, onClose: () => f.setFree(12_000_000) });
    const res = await closeAndWithdraw(closeParams, fastDeps({ api: f.api }));
    expect(res.close.success).toBe(true);
    expect(res.withdrawnNative).toBe(12_000_000);
    expect(f.calls.buildDeposit).toEqual([{ amount: 12_000_000, mode: "withdraw" }]);
    expect(f.getFree()).toBe(0); // drained back to wallet
  });

  it("throws when the close is rejected (no withdraw attempted)", async () => {
    const f = makeApi({ startFree: 0 });
    f.api.placeOrder = async () => ({ success: false, signature: null, orderPda: null, error: "no position" });
    await expect(closeAndWithdraw(closeParams, fastDeps({ api: f.api }))).rejects.toMatchObject({
      name: "TradeFlowError",
    });
    expect(f.calls.buildDeposit).toEqual([]);
  });

  it("skips withdraw when nothing is free after close", async () => {
    const f = makeApi({ startFree: 0 }); // close lands nothing (already settled elsewhere)
    const res = await closeAndWithdraw(closeParams, fastDeps({ api: f.api }));
    expect(res.withdrawnNative).toBe(0);
    expect(f.calls.buildDeposit).toEqual([]);
  });
});
