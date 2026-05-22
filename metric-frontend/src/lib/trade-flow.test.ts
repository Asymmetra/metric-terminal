import { describe, expect, it, vi } from "vitest";
import {
  depositShortfallNative,
  marketVenueCandidates,
  openWithDeposit,
  closeAndWithdraw,
  TradeFlowError,
  type FlowApi,
  type FlowDeps,
} from "./trade-flow";
import type { BalancesResponse, OrderResponse, RouteResponse, SyncSweepResponse } from "./imperial/types";
import type { OrderFormInput } from "./order-builder";

// ───────────────────────────── pure math

describe("trade-flow math", () => {
  it("depositShortfallNative deposits exactly the collateral shortfall (no buffer)", () => {
    expect(depositShortfallNative(10, 0)).toBe(10_000_000);
    expect(depositShortfallNative(10, 5_000_000)).toBe(5_000_000);
  });
  it("depositShortfallNative is 0 when already funded", () => {
    expect(depositShortfallNative(10, 10_000_000)).toBe(0);
    expect(depositShortfallNative(10, 50_000_000)).toBe(0);
  });
});

// ───────────────────────────── venue routing

const route = (candidates: { venue: string; filteredReason?: string | null }[], venue = candidates[0]?.venue): RouteResponse =>
  ({ venue, candidates: candidates.map((c) => ({ ...c, filteredReason: c.filteredReason ?? null })) } as never);

describe("marketVenueCandidates", () => {
  it("drops Phoenix for market orders, keeps cost order", () => {
    const r = route([{ venue: "phoenix" }, { venue: "flash_trade" }, { venue: "gmtrade" }, { venue: "jupiter" }]);
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toEqual([
      "flash_trade",
      "gmtrade",
      "jupiter",
    ]);
  });
  it("returns [] for a Phoenix-only asset on a market order", () => {
    const r = route([{ venue: "phoenix" }]);
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toEqual([]);
  });
  it("drops candidates with a filteredReason", () => {
    const r = route([{ venue: "phoenix" }, { venue: "flash_trade", filteredReason: "too large" }, { venue: "gmtrade" }]);
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toEqual(["gmtrade"]);
  });
  it("puts an explicitly-selected non-Phoenix venue first", () => {
    const r = route([{ venue: "flash_trade" }, { venue: "gmtrade" }]);
    expect(marketVenueCandidates({ type: "market", selectedVenue: "gmtrade", route: r })).toEqual([
      "gmtrade",
      "flash_trade",
    ]);
  });
  it("falls back to GMTrade when route is unavailable (market)", () => {
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: null })).toEqual(["gmtrade"]);
  });
  it("keeps the selected venue for limit orders (Phoenix is fine)", () => {
    expect(marketVenueCandidates({ type: "limit", selectedVenue: "phoenix", route: null })).toEqual(["phoenix"]);
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
  onOrder?: (req: { underwriter: number; action: number }) => OrderResponse; // override order outcome
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
      return opts.onOrder ? opts.onOrder(req) : ORDER_OK;
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
  it("deposits exactly the collateral shortfall, waits for funds, then opens", async () => {
    const f = makeApi({ startFree: 0, onDeposit: (amt) => f.setFree(amt) });
    const onStep = vi.fn();
    const res = await openWithDeposit(baseInput, fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_000_000)), onStep }));
    expect(f.calls.buildDeposit).toEqual([{ amount: 10_000_000, mode: "deposit" }]);
    expect(res.depositedNative).toBe(10_000_000);
    expect(res.order.success).toBe(true);
    expect(res.venue).toBe("phoenix"); // baseInput.venue, no candidates passed
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

  it("falls through venues until one fills, depositing only once", async () => {
    // gmtrade (underwriter 3) accepts; flash_trade (1) rejects.
    const f = makeApi({
      startFree: 0,
      onDeposit: (amt) => f.setFree(amt),
      onOrder: (req) =>
        req.underwriter === 3 ? ORDER_OK : { success: false, signature: null, orderPda: null, error: "route too large" },
    });
    const res = await openWithDeposit(
      baseInput,
      fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_000_000)), venues: ["flash_trade", "gmtrade"] })
    );
    expect(res.venue).toBe("gmtrade");
    expect(res.order.success).toBe(true);
    expect(f.calls.buildDeposit.length).toBe(1); // deposited once despite the fall-through
    expect(f.calls.orders).toBe(2); // flash rejected, gmtrade filled
  });

  it("throws TradeFlowError (funds safe) when every venue rejects", async () => {
    const f = makeApi({
      startFree: 0,
      onDeposit: (amt) => f.setFree(amt),
      onOrder: () => ({ success: false, signature: null, orderPda: null, error: "rejected" }),
    });
    await expect(
      openWithDeposit(
        baseInput,
        fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_000_000)), venues: ["flash_trade", "gmtrade"] })
      )
    ).rejects.toMatchObject({ name: "TradeFlowError", depositedNative: 10_000_000 });
  });

  it("calls assertDepositReady before depositing", async () => {
    const f = makeApi({ startFree: 0, onDeposit: (amt) => f.setFree(amt) });
    const assertDepositReady = vi.fn(async () => {});
    await openWithDeposit(
      baseInput,
      fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_000_000)), assertDepositReady })
    );
    expect(assertDepositReady).toHaveBeenCalledWith(10_000_000);
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
