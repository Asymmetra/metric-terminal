import { describe, expect, it, vi } from "vitest";
import {
  depositShortfallNative,
  marketVenueCandidates,
  openWithDeposit,
  closeAndWithdraw,
  isTransientResolveError,
  isRetryableOrderError,
  isOrderBotDown,
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
  it("honors the router's pick first and KEEPS Phoenix (its market orders fill)", () => {
    const r = route([{ venue: "phoenix" }, { venue: "flash_trade" }, { venue: "gmtrade" }, { venue: "jupiter" }]); // venue=phoenix
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toEqual([
      "phoenix",
      "flash_trade",
      "gmtrade",
      "jupiter",
    ]);
  });
  it("puts the router venue first, then the rest in cost order", () => {
    const r = route([{ venue: "phoenix" }, { venue: "gmtrade" }, { venue: "flash_trade" }], "gmtrade");
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toEqual([
      "gmtrade",
      "phoenix",
      "flash_trade",
    ]);
  });
  it("Phoenix-only asset → just Phoenix (no longer excluded)", () => {
    const r = route([{ venue: "phoenix" }]);
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toEqual(["phoenix"]);
  });
  it("drops candidates with a filteredReason (but keeps the router venue)", () => {
    const r = route([{ venue: "phoenix" }, { venue: "flash_trade", filteredReason: "too large" }, { venue: "gmtrade" }]); // venue=phoenix
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toEqual(["phoenix", "gmtrade"]);
  });
  it("an explicit venue choice wins, ahead of the router pick", () => {
    const r = route([{ venue: "phoenix" }, { venue: "gmtrade" }, { venue: "flash_trade" }]); // venue=phoenix
    expect(marketVenueCandidates({ type: "market", selectedVenue: "gmtrade", route: r })).toEqual([
      "gmtrade",
      "phoenix",
      "flash_trade",
    ]);
  });
  it("includes flash_v2 when /route ranks it, and an explicit flash_v2 pick leads", () => {
    const r = route([{ venue: "flash_v2" }, { venue: "phoenix" }, { venue: "gmtrade" }], "phoenix");
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: r })).toContain("flash_v2");
    expect(marketVenueCandidates({ type: "market", selectedVenue: "flash_v2", route: r })[0]).toBe("flash_v2");
  });
  it("falls back to GMTrade only when route is unavailable (market)", () => {
    expect(marketVenueCandidates({ type: "market", selectedVenue: "auto", route: null })).toEqual(["gmtrade"]);
  });
  it("keeps the selected venue for limit orders (Phoenix is fine)", () => {
    expect(marketVenueCandidates({ type: "limit", selectedVenue: "phoenix", route: null })).toEqual(["phoenix"]);
  });
});

// ───────────────────────────── venue-aware marketPrice scale (regression for the bug)

describe("toMarketPrice (venue-specific scale)", () => {
  it("scales Phoenix marketPrice at 1e6, others at 1e9", async () => {
    const { toMarketPrice } = await import("./order-builder");
    expect(toMarketPrice(84.66, "phoenix")).toBe(84_660_000); // 1e6 — the fix
    expect(toMarketPrice(84.66, "gmtrade")).toBe(84_660_000_000); // 1e9
    expect(toMarketPrice(84.66, "jupiter")).toBe(84_660_000_000);
    expect(toMarketPrice(84.66, "flash_trade")).toBe(84_660_000_000);
    expect(toMarketPrice(84.66, "flash_v2")).toBe(84_660_000_000);
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
  orderBotStatus?: string; // when set, exposes getStatus() reporting this orderBot.status
}) {
  let free = opts.startFree;
  const calls = { buildDeposit: [] as { amount: number; mode: string }[], orders: 0, sweeps: 0, status: 0 };
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
  if (opts.orderBotStatus !== undefined) {
    api.getStatus = async () => {
      calls.status += 1;
      return { db: "healthy", indexer: { status: "healthy" }, orderBot: { status: opts.orderBotStatus! } };
    };
  }
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

  it("retries the same venue once on a transient cold-cache resolve miss, then fills", async () => {
    // Flash V2's market cache warms at runtime — the first create can miss, the retry fills.
    let attempts = 0;
    const f = makeApi({
      startFree: 20_000_000,
      onOrder: () => {
        attempts += 1;
        return attempts === 1
          ? { success: false, signature: null, orderPda: null, error: 'could not resolve symbol "SOL" for underwriter 4' }
          : ORDER_OK;
      },
    });
    const res = await openWithDeposit(
      { ...baseInput, venue: "flash_v2" },
      fastDeps({ api: f.api, venues: ["flash_v2"], resolveRetryMs: 0 })
    );
    expect(res.order.success).toBe(true);
    expect(res.venue).toBe("flash_v2");
    expect(f.calls.orders).toBe(2); // missed once (cold cache), retried, filled
  });

  it("does NOT retry on a hard (non-resolve) rejection — fails immediately", async () => {
    const f = makeApi({
      startFree: 20_000_000,
      onOrder: () => ({ success: false, signature: null, orderPda: null, error: "insufficient margin" }),
    });
    await expect(
      openWithDeposit(
        { ...baseInput, venue: "flash_v2" },
        fastDeps({ api: f.api, venues: ["flash_v2"], resolveRetryMs: 0 })
      )
    ).rejects.toMatchObject({ name: "TradeFlowError" });
    expect(f.calls.orders).toBe(1); // no retry on a hard rejection
  });

  it("retries a transient 'please try again' placement failure, then fills", async () => {
    // The high-leverage Flash V2 path often bounces the first create with a
    // retryable "Failed to place order — please try again"; persistence wins.
    let attempts = 0;
    const f = makeApi({
      startFree: 20_000_000,
      onOrder: () => {
        attempts += 1;
        return attempts < 3
          ? { success: false, signature: null, orderPda: null, error: "Failed to place order — please try again." }
          : ORDER_OK;
      },
    });
    const res = await openWithDeposit(
      { ...baseInput, venue: "flash_v2" },
      fastDeps({ api: f.api, venues: ["flash_v2"], orderRetries: 5, orderRetryMs: 0 })
    );
    expect(res.order.success).toBe(true);
    expect(f.calls.orders).toBe(3); // bounced twice (retryable), filled on the third
  });

  it("gives up after orderRetries attempts on a persistent retryable rejection (funds safe)", async () => {
    const f = makeApi({
      startFree: 20_000_000,
      onOrder: () => ({ success: false, signature: null, orderPda: null, error: "please try again" }),
    });
    await expect(
      openWithDeposit(
        { ...baseInput, venue: "flash_v2" },
        fastDeps({ api: f.api, venues: ["flash_v2"], orderRetries: 3, orderRetryMs: 0 })
      )
    ).rejects.toMatchObject({ name: "TradeFlowError" });
    expect(f.calls.orders).toBe(3); // exactly orderRetries attempts, then fall through
  });
});

describe("order-bot preflight", () => {
  it("refuses to open and takes NO deposit when the order bot is unhealthy", async () => {
    const f = makeApi({ startFree: 0, onDeposit: (amt) => f.setFree(amt), orderBotStatus: "unhealthy" });
    const signFn = vi.fn();
    await expect(
      openWithDeposit(baseInput, fastDeps({ api: f.api, signer: makeSigner(signFn) }))
    ).rejects.toMatchObject({ name: "TradeFlowError", depositedNative: 0 });
    expect(f.calls.status).toBe(1);
    expect(f.calls.buildDeposit).toEqual([]); // never funded a doomed order
    expect(f.calls.orders).toBe(0); // never even attempted placement
    expect(signFn).not.toHaveBeenCalled();
  });

  it("opens normally when the order bot is healthy", async () => {
    const f = makeApi({ startFree: 20_000_000, orderBotStatus: "healthy" });
    const res = await openWithDeposit(baseInput, fastDeps({ api: f.api }));
    expect(f.calls.status).toBe(1);
    expect(res.order.success).toBe(true);
  });

  it("fails open (still trades) when the status probe itself errors", async () => {
    const f = makeApi({ startFree: 20_000_000, orderBotStatus: "healthy" });
    f.api.getStatus = async () => { throw new Error("status 500"); };
    const res = await openWithDeposit(baseInput, fastDeps({ api: f.api }));
    expect(res.order.success).toBe(true); // a flaky health probe must not block trading
  });
});

describe("isOrderBotDown", () => {
  it("is true only for an explicit non-healthy status", () => {
    expect(isOrderBotDown({ db: "", indexer: { status: "" }, orderBot: { status: "unhealthy" } })).toBe(true);
    expect(isOrderBotDown({ db: "", indexer: { status: "" }, orderBot: { status: "degraded" } })).toBe(true);
    expect(isOrderBotDown({ db: "", indexer: { status: "" }, orderBot: { status: "healthy" } })).toBe(false);
    expect(isOrderBotDown({ db: "", indexer: { status: "" }, orderBot: { status: "HEALTHY" } })).toBe(false);
    expect(isOrderBotDown(null)).toBe(false); // unknown ⇒ fail open
    expect(isOrderBotDown(undefined)).toBe(false);
  });
});

describe("isRetryableOrderError", () => {
  it("flags transient placement failures", () => {
    expect(isRetryableOrderError("Failed to place order — please try again.")).toBe(true);
    expect(isRetryableOrderError("request timed out")).toBe(true);
    expect(isRetryableOrderError("service unavailable (503)")).toBe(true);
    expect(isRetryableOrderError("too many requests")).toBe(true);
  });
  it("does not flag terminal rejections or empty errors", () => {
    expect(isRetryableOrderError("insufficient margin")).toBe(false);
    expect(isRetryableOrderError("max leverage exceeded")).toBe(false);
    expect(isRetryableOrderError("route too large")).toBe(false);
    expect(isRetryableOrderError(null)).toBe(false);
    expect(isRetryableOrderError(undefined)).toBe(false);
  });
});

describe("isTransientResolveError", () => {
  it("flags cold-cache symbol-resolution misses", () => {
    expect(isTransientResolveError('could not resolve symbol "SOL" for underwriter 4')).toBe(true);
    expect(isTransientResolveError("check that the venue lists this market")).toBe(true);
  });
  it("does not flag hard rejections or empty errors", () => {
    expect(isTransientResolveError("insufficient margin")).toBe(false);
    expect(isTransientResolveError("max leverage exceeded")).toBe(false);
    expect(isTransientResolveError(null)).toBe(false);
    expect(isTransientResolveError(undefined)).toBe(false);
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
