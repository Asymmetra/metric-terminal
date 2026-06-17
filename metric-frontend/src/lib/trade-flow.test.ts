import { describe, expect, it, vi } from "vitest";
import {
  depositShortfallNative,
  marketVenueCandidates,
  openWithDeposit,
  closeAndWithdraw,
  isTransientResolveError,
  isRetryableOrderError,
  isOrderBotDown,
  placeOrderWithRetry,
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
  startV2?: number; // when set, exposes getV2Balance() seeded with this ledger balance (profile 0)
  stageToV2?: boolean; // when true, a deposit raises the V2 ledger (simulating flash_v2 auto-staging) not free
}) {
  let free = opts.startFree;
  let v2 = opts.startV2 ?? 0;
  const calls = { buildDeposit: [] as { amount: number; mode: string }[], orders: 0, sweeps: 0, status: 0, v2: 0 };
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
      if (req.mode === "deposit") {
        if (opts.stageToV2) v2 += req.amount; // flash_v2: deposit lands in the V2 ledger, not free
        else opts.onDeposit?.(req.amount);
      }
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
  if (opts.startV2 !== undefined || opts.stageToV2) {
    api.getV2Balance = async () => {
      calls.v2 += 1;
      return {
        wallet: "W",
        profiles: [0, 1, 2, 3, 4, 5].map((i) => ({ profileIndex: i, profilePda: `pda${i}`, availableUsdc: i === 0 ? v2 : 0 })),
      };
    };
  }
  return {
    api,
    calls,
    setFree: (v: number) => (free = v),
    getFree: () => free,
    getV2: () => v2,
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

describe("flash_v2 V2-ledger settle gate", () => {
  it("settles a double-down via the V2 ledger when profile-free never rises", async () => {
    // Prior collateral already sits in the ledger; profile-free stays 0 and the new
    // deposit auto-stages into the ledger. The gate must recognise the V2 delta.
    const f = makeApi({ startFree: 0, startV2: 10_000_000, stageToV2: true });
    const res = await openWithDeposit(
      { ...baseInput, venue: "flash_v2" },
      fastDeps({ api: f.api, venues: ["flash_v2"], signer: makeSigner() })
    );
    expect(res.order.success).toBe(true);
    expect(res.depositedNative).toBe(10_000_000); // deposited the increment
    expect(f.getV2()).toBe(20_000_000); // ledger rose by the deposit
    expect(f.calls.v2).toBeGreaterThan(0); // the gate actually consulted the ledger
  });

  it("settles a first open whose deposit lands in profile-free, even with prior ledger balance", async () => {
    // Realistic first-open path: the deposit raises profile-FREE (the bot only stages to V2
    // around fill), and the player already had idle ledger collateral. The free+V2 gate passes.
    const f = makeApi({ startFree: 0, startV2: 5_000_000, onDeposit: (amt) => f.setFree(amt) });
    const res = await openWithDeposit(
      { ...baseInput, venue: "flash_v2" },
      fastDeps({ api: f.api, venues: ["flash_v2"], signer: makeSigner(() => f.setFree(10_000_000)) })
    );
    expect(res.order.success).toBe(true);
    expect(f.getFree()).toBe(10_000_000); // deposit landed in profile-free, not the ledger
  });

  it("does NOT pass prematurely on pre-existing ledger balance — times out if the deposit never lands", async () => {
    // V2 already holds $10 but the new deposit lands nowhere; the delta target
    // (before + deposit) is never reached, so funds-safe timeout, not a false pass.
    const f = makeApi({ startFree: 0, startV2: 10_000_000 }); // stageToV2 false → deposit vanishes
    await expect(
      openWithDeposit(
        { ...baseInput, venue: "flash_v2" },
        fastDeps({ api: f.api, venues: ["flash_v2"], signer: makeSigner(), settleTimeoutMs: 50 })
      )
    ).rejects.toMatchObject({ name: "TradeFlowError" });
  });

  it("does NOT consult the V2 ledger for non-flash_v2 venues (unchanged gate)", async () => {
    const f = makeApi({ startFree: 0, startV2: 5_000_000, onDeposit: (amt) => f.setFree(amt) });
    const res = await openWithDeposit(
      baseInput, // venue: phoenix
      fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_000_000)) })
    );
    expect(res.order.success).toBe(true);
    expect(f.calls.v2).toBe(0); // profile-free gate only
  });
});

describe("non-blocking deposit confirm", () => {
  it("completes the open even if the deposit confirm never resolves", async () => {
    const f = makeApi({ startFree: 0, onDeposit: (amt) => f.setFree(amt) });
    const neverResolves = () => new Promise<void>(() => {}); // hangs forever
    const res = await openWithDeposit(
      baseInput,
      fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(10_000_000)), confirm: neverResolves })
    );
    expect(res.order.success).toBe(true); // the balance poll is authoritative; confirm is fire-and-forget
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

// ───────────────────────────── shared retry loop (open + both close paths use this)

describe("placeOrderWithRetry (the single shared loop)", () => {
  const OK: OrderResponse = { success: true, signature: "sig", orderPda: null, error: null };
  const fail = (error: string): OrderResponse => ({ success: false, signature: null, orderPda: null, error });
  const noSleep = async () => {};
  const baseOpts = { maxAttempts: 5, resolveRetryMs: 10, orderRetryMs: 20, sleep: noSleep };

  it("returns immediately on a first-attempt success (one placement)", async () => {
    const place = vi.fn(async () => OK);
    const res = await placeOrderWithRetry(place, baseOpts);
    expect(res.success).toBe(true);
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 'please try again' placement bounce, then fills", async () => {
    let n = 0;
    const place = vi.fn(async () => (++n < 3 ? fail("Failed to place order — please try again.") : OK));
    const res = await placeOrderWithRetry(place, baseOpts);
    expect(res.success).toBe(true);
    expect(place).toHaveBeenCalledTimes(3);
  });

  it("retries a cold-cache resolve miss, then fills", async () => {
    let n = 0;
    const place = vi.fn(async () => (++n < 2 ? fail('could not resolve symbol "SOL" for underwriter 4') : OK));
    const res = await placeOrderWithRetry(place, baseOpts);
    expect(res.success).toBe(true);
    expect(place).toHaveBeenCalledTimes(2);
  });

  it("stops IMMEDIATELY on a hard rejection — never burns retries or loops", async () => {
    const place = vi.fn(async () => fail("insufficient margin"));
    const onRetry = vi.fn();
    const res = await placeOrderWithRetry(place, { ...baseOpts, onRetry });
    expect(res.success).toBe(false);
    expect(res.error).toBe("insufficient margin");
    expect(place).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("gives up after exactly maxAttempts on a persistent transient failure", async () => {
    const place = vi.fn(async () => fail("please try again"));
    const res = await placeOrderWithRetry(place, { ...baseOpts, maxAttempts: 4 });
    expect(res.success).toBe(false);
    expect(place).toHaveBeenCalledTimes(4);
  });

  it("clamps maxAttempts below 1 to a single attempt", async () => {
    const place = vi.fn(async () => fail("please try again"));
    await placeOrderWithRetry(place, { ...baseOpts, maxAttempts: 0 });
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("fires onAttempt at the start of every attempt (1..maxAttempts)", async () => {
    const place = vi.fn(async () => fail("please try again"));
    const onAttempt = vi.fn();
    await placeOrderWithRetry(place, { ...baseOpts, maxAttempts: 3, onAttempt });
    expect(onAttempt.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("fires onRetry(attempt,total) only before a follow-up attempt, not after the last", async () => {
    const place = vi.fn(async () => fail("please try again"));
    const onRetry = vi.fn();
    await placeOrderWithRetry(place, { ...baseOpts, maxAttempts: 3, onRetry });
    // 3 attempts → 2 retries announced; never after the terminal attempt.
    expect(onRetry.mock.calls).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });

  it("uses resolveRetryMs for a resolve miss and orderRetryMs for a placement bounce", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    // attempt 1: resolve miss (→ resolveRetryMs), attempt 2: placement bounce (→ orderRetryMs), attempt 3: fill
    let n = 0;
    const place = vi.fn(async () => {
      n += 1;
      if (n === 1) return fail('could not resolve symbol "SOL" for underwriter 4');
      if (n === 2) return fail("Failed to place order — please try again.");
      return OK;
    });
    await placeOrderWithRetry(place, { maxAttempts: 5, resolveRetryMs: 10, orderRetryMs: 20, sleep });
    expect(slept).toEqual([10, 20]); // class-specific back-off
  });

  it("does NOT sleep after the final failed attempt (no trailing delay)", async () => {
    const place = vi.fn(async () => fail("please try again"));
    const sleep = vi.fn(async () => {});
    await placeOrderWithRetry(place, { maxAttempts: 3, resolveRetryMs: 10, orderRetryMs: 10, sleep });
    expect(sleep).toHaveBeenCalledTimes(2); // 3 attempts → 2 inter-attempt sleeps
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
    // Short timeout so the settle poll (which never rises above 0) doesn't busy-loop for
    // the full default — same behavior, deterministic and fast.
    const res = await closeAndWithdraw(closeParams, fastDeps({ api: f.api, settleTimeoutMs: 5, pollIntervalMs: 1 }));
    expect(res.withdrawnNative).toBe(0);
    expect(f.calls.buildDeposit).toEqual([]);
  });

  // ── close-order retry (the same "Failed to place order — please try again" loop,
  //    but on the terminal /Positions close & withdraw path).
  it("retries a transient 'please try again' close bounce, then settles & withdraws", async () => {
    // Reproduces the active bug on the close path: a Decrease order that bounces with a
    // retryable error must be RE-PLACED, not thrown as a hard "Close rejected".
    let attempts = 0;
    const f = makeApi({ startFree: 0 });
    f.api.placeOrder = async (req) => {
      if (req.action !== 1) return ORDER_OK; // not a close
      attempts += 1;
      if (attempts < 3) return { success: false, signature: null, orderPda: null, error: "Failed to place order — please try again." };
      f.setFree(12_000_000); // the fill finally lands; proceeds settle
      return ORDER_OK;
    };
    const res = await closeAndWithdraw(
      closeParams,
      fastDeps({ api: f.api, orderRetries: 5, orderRetryMs: 0, resolveRetryMs: 0 })
    );
    expect(res.close.success).toBe(true);
    expect(attempts).toBe(3); // bounced twice (retryable), filled on the third
    expect(res.withdrawnNative).toBe(12_000_000);
  });

  it("retries a cold-cache resolve miss on close too", async () => {
    let attempts = 0;
    const f = makeApi({ startFree: 0, onClose: () => f.setFree(12_000_000) });
    f.api.placeOrder = async (req) => {
      if (req.action !== 1) return ORDER_OK;
      attempts += 1;
      if (attempts < 2) return { success: false, signature: null, orderPda: null, error: 'could not resolve symbol "SOL" for underwriter 4' };
      f.setFree(12_000_000);
      return ORDER_OK;
    };
    const res = await closeAndWithdraw(
      closeParams,
      fastDeps({ api: f.api, orderRetries: 3, orderRetryMs: 0, resolveRetryMs: 0 })
    );
    expect(res.close.success).toBe(true);
    expect(attempts).toBe(2);
  });

  it("does NOT retry a hard close rejection — throws immediately on the first attempt", async () => {
    // A terminal rejection (no position / insufficient margin) must NOT be retried;
    // retrying it is exactly what loops forever. One attempt, then a funds-safe throw.
    let attempts = 0;
    const f = makeApi({ startFree: 0 });
    f.api.placeOrder = async (req) => {
      if (req.action !== 1) return ORDER_OK;
      attempts += 1;
      return { success: false, signature: null, orderPda: null, error: "no position to close" };
    };
    await expect(
      closeAndWithdraw(closeParams, fastDeps({ api: f.api, orderRetries: 5, orderRetryMs: 0 }))
    ).rejects.toMatchObject({ name: "TradeFlowError" });
    expect(attempts).toBe(1); // hard rejection → no retry
    expect(f.calls.buildDeposit).toEqual([]); // never reached the withdraw
  });

  it("gives up after orderRetries on a persistent retryable close failure (funds safe)", async () => {
    let attempts = 0;
    const f = makeApi({ startFree: 0 });
    f.api.placeOrder = async (req) => {
      if (req.action !== 1) return ORDER_OK;
      attempts += 1;
      return { success: false, signature: null, orderPda: null, error: "please try again" };
    };
    await expect(
      closeAndWithdraw(closeParams, fastDeps({ api: f.api, orderRetries: 3, orderRetryMs: 0 }))
    ).rejects.toMatchObject({ name: "TradeFlowError" });
    expect(attempts).toBe(3); // exactly orderRetries placements, then surfaces the failure
  });

  it("surfaces TradeFlowError(closed=true) when the close succeeds but the withdraw popup is rejected", async () => {
    // Funds-safe path: position IS closed, only the wallet signature for the withdraw
    // failed. The error must carry `closed` so the UI shows a calm note, not a hard fail.
    const f = makeApi({ startFree: 0, onClose: () => f.setFree(8_000_000) });
    const rejectingSigner = {
      ...makeSigner(),
      async signAndSendTransaction() {
        throw new Error("user rejected the request");
      },
    };
    await expect(
      closeAndWithdraw(closeParams, fastDeps({ api: f.api, signer: rejectingSigner }))
    ).rejects.toMatchObject({ name: "TradeFlowError", closed: true, depositedNative: 0 });
  });

  // ── sweep / settle-timeout coverage (the swept branch + funds-safe timeout) ──

  it("runs a SECOND settle poll after a 'swept' sweep, then withdraws post-sweep proceeds", async () => {
    // Token-collateral venue: the close lands NOTHING into free USDC; the residue
    // (WSOL/WBTC) only converts to USDC when the sweep returns 'swept'. The swept
    // branch (trade-flow.ts:540-547) must run a SECOND settle poll so funds that
    // land only AFTER the sweep are still withdrawn — not skipped.
    let balancePolls = 0;
    const f = makeApi({ startFree: 0, sweepStatus: "swept" }); // close: no onClose → free stays 0
    f.api.getBalances = async () => {
      balancePolls += 1;
      return balances(f.getFree());
    };
    // The sweep is what converts residue → free USDC. Bump free when it runs so the
    // post-sweep poll observes the rise and the withdraw drains it.
    f.api.syncProfileSweep = async () => {
      f.setFree(9_000_000);
      return { status: "swept", message: "swept WSOL", balances: null };
    };
    // Short timeout: the FIRST settle poll never sees free rise (residue not yet swept),
    // so it must time out quickly; the sweep then lands proceeds and the post-sweep poll
    // passes on its first check. Keeps the test fast + deterministic (no real waits).
    const res = await closeAndWithdraw(closeParams, fastDeps({ api: f.api, settleTimeoutMs: 5, pollIntervalMs: 1 }));
    expect(res.sweep?.status).toBe("swept");
    expect(res.withdrawnNative).toBe(9_000_000); // post-sweep proceeds withdrawn
    expect(f.getFree()).toBe(0); // drained back to wallet
    expect(f.calls.buildDeposit).toEqual([{ amount: 9_000_000, mode: "withdraw" }]);
    // pre-close snapshot + first settle poll + post-sweep poll + final read ⇒ several polls,
    // and the post-sweep poll PASSED (free rose) rather than burning the full timeout.
    expect(balancePolls).toBeGreaterThanOrEqual(4);
  });

  it("withdraws whatever is free at timeout when the settle poll never rises (funds-safe)", async () => {
    // The settle poll TIMES OUT: proceeds never appear above preCloseFree after the
    // close (onClose is a no-op). pollUntil's timeout path must NOT abort the flow —
    // it proceeds and withdraws whatever free balance already exists. Here the profile
    // started with $5 free, the close added nothing, so $5 is still withdrawn.
    const f = makeApi({ startFree: 5_000_000 }); // close: no onClose → free never rises
    const res = await closeAndWithdraw(
      closeParams,
      fastDeps({ api: f.api, settleTimeoutMs: 30, pollIntervalMs: 5 })
    );
    expect(res.close.success).toBe(true);
    expect(res.withdrawnNative).toBe(5_000_000); // pre-existing free, withdrawn despite no settle
    expect(f.calls.buildDeposit).toEqual([{ amount: 5_000_000, mode: "withdraw" }]);
    expect(f.getFree()).toBe(0);
  });

  it("swallows a throwing syncProfileSweep (best-effort) and still withdraws", async () => {
    // The sweep is best-effort: if syncProfileSweep rejects, the try/catch at
    // trade-flow.ts:548-550 must swallow it — the close already settled proceeds into
    // free, so the withdraw proceeds normally and sweep is reported as null.
    const f = makeApi({ startFree: 0, onClose: () => f.setFree(7_000_000) });
    f.api.syncProfileSweep = async () => {
      throw new Error("sweep endpoint 500");
    };
    const res = await closeAndWithdraw(closeParams, fastDeps({ api: f.api }));
    expect(res.close.success).toBe(true);
    expect(res.sweep).toBeNull(); // throw swallowed → no sweep result, no hard failure
    expect(res.withdrawnNative).toBe(7_000_000); // settled proceeds still withdrawn
    expect(f.calls.buildDeposit).toEqual([{ amount: 7_000_000, mode: "withdraw" }]);
  });
});
