import { describe, expect, it, vi } from "vitest";
import {
  openTouchWithDeposit,
  sellBackTouch,
  claimTouch,
  isTouchQuoteMoved,
  isTerminalCloseError,
  TOUCH_PROFILE,
  type TouchFlowApi,
  type TouchFlowDeps,
  type OpenTouchInput,
} from "./touch-flow";
import {
  buildTouchOpenRequest,
  buildTouchCloseRequest,
  touchPremiumBudget,
} from "./touch-order";
import type { BalancesResponse, OrderResponse } from "./imperial/types";
import { Action, OrderType, Side, Underwriter } from "./imperial/types";

// ───────────────────────────── request builders (contract mapping)

describe("buildTouchOpenRequest", () => {
  it("maps barrier→triggerPrice, payout→sizeUsd, budget→collateralAmount, side, underwriter 6", () => {
    const req = buildTouchOpenRequest({
      wallet: "W",
      profileIndex: TOUCH_PROFILE,
      symbol: "SOLTOUCH",
      isTouch: true,
      barrier1e9: 155_000_000_000,
      payoutUsd: 5_000_000, // $5 payout
      premiumBudgetUsd: 300_000, // µUSD budget
    });
    expect(req.underwriter).toBe(Underwriter.Touch); // 6
    expect(req.underwriter).toBe(6);
    expect(req.side).toBe(Side.Long); // 0 = Touch
    expect(req.action).toBe(Action.Increase); // 0 = open
    expect(req.orderType).toBe(OrderType.Market); // 0
    expect(req.triggerPrice).toBe(155_000_000_000); // BARRIER (1e9), unscaled
    expect(req.sizeUsd).toBe(5_000_000); // PAYOUT µUSD
    expect(req.collateralAmount).toBe(300_000); // PREMIUM BUDGET µUSD
    expect(req.slippageBps).toBe(0);
    expect(req.symbol).toBe("SOLTOUCH"); // bare symbol → 24h tenor
    expect(req.marketMint).toBeNull();
  });

  it("No-Touch sets side=1; a marketMint prefers the PDA over the bare symbol", () => {
    const req = buildTouchOpenRequest({
      wallet: "W",
      profileIndex: TOUCH_PROFILE,
      symbol: "SOLTOUCH",
      marketMint: "PDA_1H",
      isTouch: false,
      barrier1e9: 145_000_000_000,
      payoutUsd: 5_000_000,
      premiumBudgetUsd: 300_000,
    });
    expect(req.side).toBe(Side.Short); // 1 = No-Touch
    expect(req.marketMint).toBe("PDA_1H");
    expect(req.symbol).toBeNull(); // symbol dropped when a PDA is present
  });
});

describe("buildTouchCloseRequest", () => {
  it("maps positionId+1→triggerPrice (an ID, not a price) and echoes payoutUsd→sizeUsd", () => {
    const req = buildTouchCloseRequest({
      wallet: "W",
      profileIndex: TOUCH_PROFILE,
      symbol: "SOLTOUCH",
      positionId: 0, // id 0 → send 1
      payoutUsd: 5_000_007, // byte-for-byte echo (rounding-different is refused)
      minRefundUsd: 0,
    });
    expect(req.underwriter).toBe(6);
    expect(req.action).toBe(Action.Decrease); // 1 = close
    expect(req.orderType).toBe(OrderType.Market);
    expect(req.triggerPrice).toBe(1); // positionId(0) + 1 — an ID, NOT 1e9-scaled
    expect(req.sizeUsd).toBe(5_000_007); // echoed byte-for-byte
    expect(req.collateralAmount).toBe(0); // min-refund floor (0 = any bid)
  });

  it("positionId 7 → triggerPrice 8", () => {
    const req = buildTouchCloseRequest({
      wallet: "W",
      profileIndex: TOUCH_PROFILE,
      symbol: "SOLTOUCH",
      positionId: 7,
      payoutUsd: 1_000_000,
      minRefundUsd: 250_000,
    });
    expect(req.triggerPrice).toBe(8);
    expect(req.collateralAmount).toBe(250_000);
  });
});

// ───────────────────────────── premium-budget math (askBps + 100bps slack)

describe("touchPremiumBudget", () => {
  it("budget = ceil(payout * askBps / 10000) + round(payout * 0.01) (100bps slack)", () => {
    // $10 payout (10_000_000 µUSD) at 250 bps ask:
    //   indicative = ceil(10_000_000 * 250 / 10000) = 250_000
    //   slack      = round(10_000_000 * 0.01)       = 100_000
    expect(touchPremiumBudget(10_000_000, 250)).toBe(350_000);
  });
  it("rounds the indicative up (never under-budgets the ask)", () => {
    // 333 bps of 1_000_001: ceil(33_300.033) = 33_301; slack round(10_000.01)=10_000
    expect(touchPremiumBudget(1_000_001, 333)).toBe(33_301 + 10_000);
  });
  it("always covers >= 1 cent per $1 of payout via the slack", () => {
    // Even a 0bps ask carries 100bps (1%) of payout as slack.
    expect(touchPremiumBudget(10_000_000, 0)).toBe(100_000); // $0.10 on a $10 payout
  });
});

// ───────────────────────────── error classifiers

describe("touch error classifiers", () => {
  it("isTouchQuoteMoved matches the retryable ask-moved error", () => {
    expect(isTouchQuoteMoved("TouchQuoteMoved")).toBe(true);
    expect(isTouchQuoteMoved("the quote moved before fill")).toBe(true);
    expect(isTouchQuoteMoved("insufficient margin")).toBe(false);
    expect(isTouchQuoteMoved(null)).toBe(false);
  });
  it("isTerminalCloseError matches swept/settles-at-expiry/already-closed", () => {
    expect(isTerminalCloseError("TouchBarrierSwept")).toBe(true);
    expect(isTerminalCloseError("TouchSettlesAtExpiry")).toBe(true);
    expect(isTerminalCloseError("PositionAlreadyClosed")).toBe(true);
    expect(isTerminalCloseError("TouchQuoteMoved")).toBe(false);
    expect(isTerminalCloseError(null)).toBe(false);
  });
});

// ───────────────────────────── fakes

const ORDER_OK: OrderResponse = { success: true, signature: "ordsig", orderPda: null, error: null };
const fail = (error: string): OrderResponse => ({ success: false, signature: null, orderPda: null, error });

function balances(free: number): BalancesResponse {
  return {
    wallet: "W",
    profiles: [0, 1, 2, 3, 4, 5].map((i) => ({
      profileIndex: i,
      profilePda: `pda${i}`,
      usdc: i === TOUCH_PROFILE ? free : 0,
    })),
  };
}

/** Mutable-balance fake Imperial API + call recording (mirrors trade-flow.test). */
function makeApi(opts: {
  startFree: number;
  onDeposit?: (amount: number) => void; // mutate free to simulate landing
  onOrder?: (req: { underwriter: number; action: number }) => OrderResponse; // override buy/sell outcome
}) {
  let free = opts.startFree;
  const calls = {
    buildDeposit: [] as { amount: number; mode: string }[],
    orders: [] as { underwriter: number; action: number }[],
  };
  const api: TouchFlowApi = {
    async getBalances() {
      return balances(free);
    },
    async placeOrder(req) {
      calls.orders.push({ underwriter: req.underwriter, action: req.action });
      return opts.onOrder ? opts.onOrder(req) : ORDER_OK;
    },
    async buildDepositTx(req) {
      calls.buildDeposit.push({ amount: req.amount, mode: req.mode });
      if (req.mode === "deposit") opts.onDeposit?.(req.amount);
      if (req.mode === "withdraw") free -= req.amount;
      return { transaction: "BASE64TX" };
    },
  };
  return { api, calls, setFree: (v: number) => (free = v), getFree: () => free };
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

const openInput: OpenTouchInput = {
  wallet: "W",
  profileIndex: TOUCH_PROFILE,
  symbol: "SOLTOUCH",
  isTouch: true,
  barrier1e9: 155_000_000_000,
  payoutUsd: 10_000_000, // $10 payout
  premiumBudgetUsd: 350_000, // budget µUSD
};

const fastDeps = (extra: Partial<TouchFlowDeps>): TouchFlowDeps => ({
  signer: makeSigner(),
  jwt: "jwt",
  pollIntervalMs: 0,
  settleTimeoutMs: 1000,
  sleep: async () => {},
  requoteMs: 0,
  ...extra,
});

// ───────────────────────────── openTouchWithDeposit

describe("openTouchWithDeposit", () => {
  it("deposits the premium budget when the profile is underfunded, then buys", async () => {
    const f = makeApi({ startFree: 0, onDeposit: (amt) => f.setFree(amt) });
    const onStep = vi.fn();
    const res = await openTouchWithDeposit(
      openInput,
      fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(350_000)), onStep })
    );
    expect(f.calls.buildDeposit).toEqual([{ amount: 350_000, mode: "deposit" }]);
    expect(res.depositedNative).toBe(350_000);
    expect(res.order.success).toBe(true);
    // Buy was underwriter 6, open (action 0).
    expect(f.calls.orders).toEqual([{ underwriter: 6, action: 0 }]);
    expect(onStep.mock.calls.map((c) => c[0].step)).toContain("done");
  });

  it("SKIPS the deposit (no signature) when the profile is already funded", async () => {
    const f = makeApi({ startFree: 1_000_000 }); // $1 free, budget is $0.35
    const sign = vi.fn();
    const res = await openTouchWithDeposit(openInput, fastDeps({ api: f.api, signer: makeSigner(sign) }));
    expect(f.calls.buildDeposit).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
    expect(res.depositedNative).toBe(0);
    expect(res.order.success).toBe(true);
  });

  it("TouchQuoteMoved → SINGLE placement, throws a refresh-the-quote error; funds stay safe, no re-read", async () => {
    // Deposited first, then the ask jumped above the budget. The open must NOT
    // re-quote/escalate — it surfaces a clear "refresh the quote" error mentioning
    // the user's stated budget, carrying the deposited amount (funds safe).
    const f = makeApi({
      startFree: 0,
      onDeposit: (amt) => f.setFree(amt),
      onOrder: () => fail("TouchQuoteMoved"),
    });
    let thrown: unknown;
    await openTouchWithDeposit(
      openInput,
      fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(350_000)) })
    ).catch((e) => (thrown = e));
    expect(thrown).toMatchObject({ name: "TradeFlowError", depositedNative: 350_000 });
    // Message names the user's EXACT budget ($0.35) and tells them to refresh.
    const msg = (thrown as Error).message;
    expect(msg).toContain("$0.35");
    expect(msg).toMatch(/refresh/i);
    expect(msg).toMatch(/funds are safe/i);
    expect(f.calls.orders.length).toBe(1); // placed exactly once — no requote loop
    // The fake exposes NO getTouchDeals: the open path must never re-read /touch/deals.
    expect("getTouchDeals" in f.api).toBe(false);
  });

  it("does NOT loop on a hard (non-quote-moved) rejection — one attempt, funds flagged safe", async () => {
    const f = makeApi({
      startFree: 0,
      onDeposit: (amt) => f.setFree(amt),
      onOrder: () => fail("insufficient margin"),
    });
    await expect(
      openTouchWithDeposit(openInput, fastDeps({ api: f.api, signer: makeSigner(() => f.setFree(350_000)) }))
    ).rejects.toMatchObject({ name: "TradeFlowError", depositedNative: 350_000 });
    expect(f.calls.orders.length).toBe(1); // single placement, no loop
  });

  it("throws when the deposit doesn't settle in time (funds safe in the profile)", async () => {
    // Deposit is signed but never lands in profile-free → settle gate times out.
    const f = makeApi({ startFree: 0 /* onDeposit omitted: free stays 0 */ });
    await expect(
      openTouchWithDeposit(openInput, fastDeps({ api: f.api, settleTimeoutMs: 0 }))
    ).rejects.toMatchObject({ name: "TradeFlowError", depositedNative: 350_000 });
    expect(f.calls.orders.length).toBe(0); // never attempted the buy
  });
});

// ───────────────────────────── sellBackTouch

describe("sellBackTouch", () => {
  const params = {
    wallet: "W",
    profileIndex: TOUCH_PROFILE,
    symbol: "SOLTOUCH",
    positionId: 3,
    payoutUsd: 10_000_007,
    minRefundUsd: 0,
  };

  it("sells back with NO signature and returns the order", async () => {
    const sign = vi.fn();
    const f = makeApi({ startFree: 0 });
    const res = await sellBackTouch(params, fastDeps({ api: f.api, signer: makeSigner(sign) }));
    expect(sign).not.toHaveBeenCalled(); // bot order, no wallet signature
    expect(res.order.success).toBe(true);
    expect(f.calls.orders).toEqual([{ underwriter: 6, action: 1 }]); // close = action 1
  });

  it("retries TouchQuoteMoved in-place then succeeds", async () => {
    let attempts = 0;
    const f = makeApi({
      startFree: 0,
      onOrder: () => {
        attempts += 1;
        return attempts === 1 ? fail("TouchQuoteMoved") : ORDER_OK;
      },
    });
    const res = await sellBackTouch(params, fastDeps({ api: f.api }));
    expect(res.order.success).toBe(true);
    expect(f.calls.orders.length).toBe(2);
  });

  it.each(["TouchBarrierSwept", "TouchSettlesAtExpiry", "PositionAlreadyClosed"])(
    "terminal error %s does NOT loop — single attempt, clear error",
    async (err) => {
      const f = makeApi({ startFree: 0, onOrder: () => fail(err) });
      await expect(sellBackTouch(params, fastDeps({ api: f.api }))).rejects.toMatchObject({
        name: "TradeFlowError",
      });
      expect(f.calls.orders.length).toBe(1); // terminal → no retry
    }
  );

  it("a non-quote-moved, non-terminal rejection fails without looping", async () => {
    const f = makeApi({ startFree: 0, onOrder: () => fail("some other rejection") });
    await expect(sellBackTouch(params, fastDeps({ api: f.api, quoteRetries: 3 }))).rejects.toMatchObject({
      name: "TradeFlowError",
    });
    expect(f.calls.orders.length).toBe(1);
  });
});

// ───────────────────────────── claimTouch

describe("claimTouch", () => {
  it("withdraws the profile's full free USDC with ONE signature", async () => {
    const f = makeApi({ startFree: 12_340_000 });
    const sign = vi.fn();
    const res = await claimTouch(
      { wallet: "W", profileIndex: TOUCH_PROFILE },
      fastDeps({ api: f.api, signer: makeSigner(sign) })
    );
    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.calls.buildDeposit).toEqual([{ amount: 12_340_000, mode: "withdraw" }]);
    expect(res.withdrawnNative).toBe(12_340_000);
    expect(res.signature).toBe("txsig");
  });

  it("no-ops (no signature) when there is nothing to claim", async () => {
    const f = makeApi({ startFree: 0 });
    const sign = vi.fn();
    const res = await claimTouch(
      { wallet: "W", profileIndex: TOUCH_PROFILE },
      fastDeps({ api: f.api, signer: makeSigner(sign) })
    );
    expect(sign).not.toHaveBeenCalled();
    expect(f.calls.buildDeposit).toEqual([]);
    expect(res.withdrawnNative).toBe(0);
  });
});
