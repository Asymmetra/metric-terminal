import { describe, expect, it } from "vitest";
import {
  buildOrderRequest,
  buildCloseRequest,
  validateOrder,
  impliedLeverage,
  toUsdFixed,
  toOracle,
  VENUE_CONFIG,
  type OrderFormInput,
} from "./order-builder";
import { Action, OrderType, Side, TriggerCondition, Underwriter } from "./imperial/types";

const base: OrderFormInput = {
  wallet: "HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x",
  profileIndex: 0,
  symbol: "SOL",
  venue: "phoenix",
  side: "long",
  type: "market",
  sizeUsd: 20,
  collateralUsd: 10,
  markPrice: 87.6,
  slippageBps: 100,
};

describe("unit scaling", () => {
  it("scales USD to 6-decimal fixed point", () => {
    expect(toUsdFixed(1)).toBe(1_000_000);
    expect(toUsdFixed(20)).toBe(20_000_000);
    expect(toUsdFixed(10.5)).toBe(10_500_000);
  });
  it("scales price to 1e9 oracle scale", () => {
    expect(toOracle(1)).toBe(1_000_000_000);
    expect(toOracle(87.6)).toBe(87_600_000_000);
  });
  it("maps venues to underwriter enum", () => {
    expect(VENUE_CONFIG.phoenix.underwriter).toBe(Underwriter.Phoenix);
    expect(VENUE_CONFIG.jupiter.underwriter).toBe(Underwriter.Jupiter);
    expect(VENUE_CONFIG.flash_trade.underwriter).toBe(Underwriter.FlashTrade);
    expect(VENUE_CONFIG.gmtrade.underwriter).toBe(Underwriter.GMTrade);
    expect(VENUE_CONFIG.flash_v2.underwriter).toBe(Underwriter.FlashV2);
  });
});

describe("impliedLeverage", () => {
  it("computes size / collateral", () => {
    expect(impliedLeverage(20, 10)).toBe(2);
    expect(impliedLeverage(100, 10)).toBe(10);
  });
  it("returns 0 for zero collateral", () => {
    expect(impliedLeverage(20, 0)).toBe(0);
  });
});

describe("validateOrder", () => {
  it("accepts a valid market order", () => {
    expect(validateOrder(base)).toBeNull();
  });
  it("enforces $10 minimum collateral", () => {
    expect(validateOrder({ ...base, collateralUsd: 5 })).toMatch(/at least \$10/);
  });
  it("rejects size of zero", () => {
    expect(validateOrder({ ...base, sizeUsd: 0 })).toMatch(/position size/);
  });
  it("rejects collateral exceeding size", () => {
    expect(validateOrder({ ...base, collateralUsd: 30, sizeUsd: 20 })).toMatch(/can't exceed/);
  });
  it("requires a limit price for limit orders", () => {
    expect(validateOrder({ ...base, type: "limit" })).toMatch(/limit price/);
  });
  it("requires a wallet", () => {
    expect(validateOrder({ ...base, wallet: "" })).toMatch(/wallet/);
  });
});

describe("buildOrderRequest — market long (matches live test shape)", () => {
  const req = buildOrderRequest(base);
  it("uses Phoenix / Long / Increase / Market", () => {
    expect(req.underwriter).toBe(Underwriter.Phoenix);
    expect(req.side).toBe(Side.Long);
    expect(req.action).toBe(Action.Increase);
    expect(req.orderType).toBe(OrderType.Market);
  });
  it("scales size + collateral, and marketPrice at the Phoenix venue scale (1e6)", () => {
    expect(req.sizeUsd).toBe(20_000_000);
    expect(req.collateralAmount).toBe(10_000_000);
    // Phoenix market orders want marketPrice in 1e6 (USD 6-dec), not 1e9 — the bug fix.
    expect(req.marketPrice).toBe(87_600_000);
  });
  it("uses the 1e9 oracle scale for non-Phoenix market venues", () => {
    expect(buildOrderRequest({ ...base, venue: "gmtrade" }).marketPrice).toBe(87_600_000_000);
    expect(buildOrderRequest({ ...base, venue: "jupiter" }).marketPrice).toBe(87_600_000_000);
    expect(buildOrderRequest({ ...base, venue: "flash_v2" }).marketPrice).toBe(87_600_000_000);
  });
  it("addresses flash_v2 with underwriter code 5", () => {
    expect(buildOrderRequest({ ...base, venue: "flash_v2" }).underwriter).toBe(Underwriter.FlashV2);
  });
  it("carries the symbol and no trigger for market", () => {
    expect(req.symbol).toBe("SOL");
    expect(req.triggerPrice).toBe(0);
  });
});

describe("buildOrderRequest — limit", () => {
  it("long limit rests below mark (triggerCondition Below) at the limit price", () => {
    const req = buildOrderRequest({ ...base, type: "limit", limitPrice: 43.8 });
    expect(req.orderType).toBe(OrderType.Limit);
    expect(req.triggerCondition).toBe(TriggerCondition.Below);
    expect(req.triggerPrice).toBe(toOracle(43.8));
  });
  it("short limit rests above mark (triggerCondition Above)", () => {
    const req = buildOrderRequest({ ...base, side: "short", type: "limit", limitPrice: 95 });
    expect(req.side).toBe(Side.Short);
    expect(req.triggerCondition).toBe(TriggerCondition.Above);
  });
});

describe("buildCloseRequest", () => {
  it("builds a Decrease market order on the position side", () => {
    const req = buildCloseRequest({
      wallet: base.wallet,
      profileIndex: 0,
      symbol: "SOL",
      venue: "phoenix",
      positionSide: "long",
      sizeUsd: 20,
      markPrice: 87.6,
      slippageBps: 100,
    });
    expect(req.action).toBe(Action.Decrease);
    expect(req.side).toBe(Side.Long);
    expect(req.orderType).toBe(OrderType.Market);
    expect(req.sizeUsd).toBe(20_000_000);
    expect(req.collateralAmount).toBe(0);
  });
});
