import { describe, it, expect } from "vitest";
import {
  aggregateMarkets,
  normalizeUnderwriter,
  resolveVenueFilter,
  VENUE_ORDER,
  type AggregateInputs,
  type StatsSummary,
  type StatsMarkets,
  type MarkPrices,
  type FundingRates,
  type FlashV2Market,
  type FlashMarket,
  type PhoenixMarket,
  type GmtradeMarket,
  type GmtradeLiquidity,
} from "./markets-aggregate";

/**
 * REALISTIC fixtures built directly from the live Imperial read shapes
 * (verified 2026-07-01). Everything below mirrors what Imperial actually
 * returns — no fabricated fields. FIVE venues:
 *   flash_v2 | flash | phoenix | gmtrade | jupiter
 *
 * KEY facts these fixtures encode:
 *   - flash and flash_v2 are DISTINCT venues with SEPARATE market endpoints.
 *   - flash_v2 (GET /flash-v2/markets) is the high-leverage pool. SOL=550.
 *   - flash (v1, GET /flash/markets, underwriter "flash_trade"). SOL≈117.
 *   - summary + stats/markets byVenue have NO flash_v2 key (only combined flash).
 *   - mark-prices + funding-rates have NO flash_v2 and NO jupiter keys.
 *   - gmtrade markets have NO maxLeverage.
 *   - jupiter appears ONLY in stats (byVenue.jupiterUsd + summary).
 */

// ─────────────────────────────────────────── GET /flash-v2/markets
// TWO entries per symbol (long + short). SOL/BTC=550, WIF (a memecoin)=22.
function flashV2Markets(): FlashV2Market[] {
  return [
    {
      symbol: "SOL",
      side: "long",
      underwriter: "flash_v2",
      marketAddress: "FV2SoLLong1111111111111111111111111111111111",
      targetMint: "So11111111111111111111111111111111111111112",
      maxLeverage: 550,
      openPositionFeeRate: 0.0006,
      closePositionFeeRate: 0.0006,
      availableLiquidityUsd: 4200000,
      maxPositionSizeUsd: 1500000,
      allowOpenPosition: true,
      pythLazerSymbol: "SOL/USD",
      schedule: null,
    },
    {
      symbol: "SOL",
      side: "short",
      underwriter: "flash_v2",
      marketAddress: "FV2SoLShort111111111111111111111111111111111",
      targetMint: "So11111111111111111111111111111111111111112",
      maxLeverage: 550,
      openPositionFeeRate: 0.0006,
      closePositionFeeRate: 0.0006,
      availableLiquidityUsd: 3900000,
      maxPositionSizeUsd: 1400000,
      allowOpenPosition: true,
      pythLazerSymbol: "SOL/USD",
      schedule: null,
    },
    {
      symbol: "BTC",
      side: "long",
      underwriter: "flash_v2",
      marketAddress: "FV2BtcLong1111111111111111111111111111111111",
      targetMint: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
      maxLeverage: 550,
      openPositionFeeRate: 0.0004,
      closePositionFeeRate: null, // Imperial can return null closePositionFeeRate
      availableLiquidityUsd: 8000000,
      maxPositionSizeUsd: 3000000,
      allowOpenPosition: true,
      pythLazerSymbol: "BTC/USD",
      schedule: null,
    },
    {
      symbol: "BTC",
      side: "short",
      underwriter: "flash_v2",
      marketAddress: "FV2BtcShort111111111111111111111111111111111",
      targetMint: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
      maxLeverage: 550,
      openPositionFeeRate: 0.0004,
      closePositionFeeRate: null,
      availableLiquidityUsd: 7800000,
      maxPositionSizeUsd: 2900000,
      allowOpenPosition: true,
      pythLazerSymbol: "BTC/USD",
      schedule: null,
    },
    {
      // A flash_v2-ONLY symbol (no other venue lists it) — proves flash_v2
      // seeds the symbol universe and the venue view has no mark/funding/vol.
      symbol: "WIF",
      side: "long",
      underwriter: "flash_v2",
      marketAddress: "FV2WifLong1111111111111111111111111111111111",
      targetMint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
      maxLeverage: 22,
      openPositionFeeRate: 0.001,
      closePositionFeeRate: 0.001,
      availableLiquidityUsd: 250000,
      maxPositionSizeUsd: 75000,
      allowOpenPosition: false, // disabled side
      pythLazerSymbol: "WIF/USD",
      schedule: {},
    },
    {
      symbol: "WIF",
      side: "short",
      underwriter: "flash_v2",
      marketAddress: "FV2WifShort111111111111111111111111111111111",
      targetMint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
      maxLeverage: 22,
      openPositionFeeRate: 0.001,
      closePositionFeeRate: 0.001,
      availableLiquidityUsd: 230000,
      maxPositionSizeUsd: 70000,
      allowOpenPosition: true, // OTHER side allowed -> available should be true
      pythLazerSymbol: "WIF/USD",
      schedule: {},
    },
  ];
}

// ─────────────────────────────────────────── GET /flash/markets (v1)
// underwriter "flash_trade". SOL≈117 leverage — DELIBERATELY different from v2.
function flashMarkets(): FlashMarket[] {
  return [
    {
      symbol: "SOL",
      side: "long",
      underwriter: "flash_trade",
      maxLeverage: 117,
      openPositionFeeRate: 0.0008,
      volatilityFeeRate: 0.0001,
      maxConfBps: 25,
      allowOpenPosition: true,
      allowClosePosition: true,
      tokenDecimals: 9,
      poolName: "Crypto.1",
    },
    {
      symbol: "SOL",
      side: "short",
      underwriter: "flash_trade",
      maxLeverage: 117,
      openPositionFeeRate: 0.0008,
      volatilityFeeRate: 0.0001,
      maxConfBps: 25,
      allowOpenPosition: true,
      allowClosePosition: true,
      tokenDecimals: 9,
      poolName: "Crypto.1",
    },
    {
      symbol: "BTC",
      side: "long",
      underwriter: "flash_trade",
      maxLeverage: 100,
      openPositionFeeRate: 0.0006,
      volatilityFeeRate: 0.00008,
      maxConfBps: 20,
      allowOpenPosition: true,
      allowClosePosition: true,
      tokenDecimals: 8,
      poolName: "Crypto.1",
    },
    {
      symbol: "BTC",
      side: "short",
      underwriter: "flash_trade",
      maxLeverage: 100,
      openPositionFeeRate: 0.0006,
      volatilityFeeRate: 0.00008,
      maxConfBps: 20,
      allowOpenPosition: true,
      allowClosePosition: true,
      tokenDecimals: 8,
      poolName: "Crypto.1",
    },
  ];
}

// ─────────────────────────────────────────── GET /phoenix/markets
function phoenixMarkets(): PhoenixMarket[] {
  return [
    {
      symbol: "SOL",
      underwriter: "phoenix",
      maxLeverage: 10,
      makerFeeMicro: -200,
      takerFeeMicro: 400,
    },
    {
      symbol: "ETH",
      underwriter: "phoenix",
      maxLeverage: 10,
      makerFeeMicro: -150,
      takerFeeMicro: 350,
    },
  ];
}

// ─────────────────────────────────────────── GET /gmtrade/markets (no maxLeverage)
function gmtradeMarkets(): GmtradeMarket[] {
  return [
    {
      symbol: "SOL",
      underwriter: "gmtrade",
      market: "GmSoL111111111111111111111111111111111111111",
      oracle: "GmSoLOracle11111111111111111111111111111111",
      indexTokenDecimals: 9,
      closed: false,
    },
    {
      symbol: "ETH",
      underwriter: "gmtrade",
      market: "GmEth111111111111111111111111111111111111111",
      oracle: "GmEthOracle11111111111111111111111111111111",
      indexTokenDecimals: 8,
      closed: true, // a closed gmtrade market
    },
  ];
}

// ─────────────────────────────────────────── GET /gmtrade/liquidity
function gmtradeLiquidity(): GmtradeLiquidity[] {
  return [
    { symbol: "SOL", longAvailableUsd: 1200000, shortAvailableUsd: 950000 },
    { symbol: "ETH", longAvailableUsd: null, shortAvailableUsd: 500000 },
  ];
}

// ─────────────────────────────────────────── GET /mark-prices
// venue keys OPTIONAL per symbol; NO flash_v2, NO jupiter. `flash` here = v1.
function markPrices(): MarkPrices {
  return {
    rows: [
      {
        symbol: "SOL",
        flash: { source: "pyth", price: 152.4, fetchedAtUnixMs: 1_720_000_000_000 },
        phoenix: { source: "phoenix", price: 152.38, fetchedAtUnixMs: 1_720_000_000_100 },
        gmtrade: { source: "chainlink", price: 152.41, fetchedAtUnixMs: 1_720_000_000_050 },
      },
      {
        symbol: "BTC",
        // Only flash has a mark price for BTC.
        flash: { source: "pyth", price: 61234.5, fetchedAtUnixMs: 1_720_000_000_000 },
      },
      {
        symbol: "ETH",
        phoenix: { source: "phoenix", price: 3410.2, fetchedAtUnixMs: 1_720_000_000_100 },
        gmtrade: { source: "chainlink", price: 3410.5, fetchedAtUnixMs: 1_720_000_000_050 },
      },
    ],
  };
}

// ─────────────────────────────────────────── GET /funding-rates
// NO flash_v2, NO jupiter. `flash` here = v1. Fields nullable.
function fundingRates(): FundingRates {
  return {
    rows: [
      {
        symbol: "SOL",
        flash: {
          source: "flash",
          longFundingRatePerHourPercent: 0.0012,
          shortFundingRatePerHourPercent: -0.0009,
          longBorrowRatePerHourPercent: 0.0005,
          shortBorrowRatePerHourPercent: 0.0004,
        },
        phoenix: {
          source: "phoenix",
          longFundingRatePerHourPercent: 0.0001,
          shortFundingRatePerHourPercent: -0.0001,
          // phoenix exposes no borrow rates -> nulls
          longBorrowRatePerHourPercent: null,
          shortBorrowRatePerHourPercent: null,
        },
        gmtrade: {
          source: "gmtrade",
          longFundingRatePerHourPercent: null,
          shortFundingRatePerHourPercent: null,
          longBorrowRatePerHourPercent: 0.0007,
          shortBorrowRatePerHourPercent: 0.0006,
        },
      },
      {
        symbol: "BTC",
        flash: {
          source: "flash",
          longFundingRatePerHourPercent: 0.0008,
          shortFundingRatePerHourPercent: -0.0006,
          longBorrowRatePerHourPercent: 0.0003,
          shortBorrowRatePerHourPercent: 0.0003,
        },
      },
    ],
  };
}

// ─────────────────────────────────────────── GET /stats/markets?period=24h
// byVenue has NO flash_v2 key — only combined flashUsd. All *Usd are STRINGS.
function statsMarkets(): StatsMarkets {
  return {
    period: "24h",
    rows: [
      {
        symbol: "SOL",
        volumeUsd: "9500000.50",
        openInterestUsd: "3200000.00",
        longOiUsd: "1800000.00",
        shortOiUsd: "1400000.00",
        traderCount: 812,
        positionCount: 1340,
        byVenue: {
          jupiterUsd: "4000000.00",
          flashUsd: "3500000.50",
          phoenixUsd: "1500000.00",
          gmtradeUsd: "500000.00",
        },
      },
      {
        symbol: "BTC",
        volumeUsd: "12000000.00",
        openInterestUsd: "6000000.00",
        longOiUsd: "3500000.00",
        shortOiUsd: "2500000.00",
        traderCount: 540,
        positionCount: 900,
        byVenue: {
          jupiterUsd: "7000000.00",
          flashUsd: "5000000.00",
          phoenixUsd: "0",
          gmtradeUsd: "0",
        },
      },
      {
        symbol: "ETH",
        volumeUsd: "3000000.00",
        openInterestUsd: "1500000.00",
        longOiUsd: "900000.00",
        shortOiUsd: "600000.00",
        traderCount: 210,
        positionCount: 380,
        byVenue: {
          jupiterUsd: "0",
          flashUsd: "0",
          phoenixUsd: "1200000.00",
          gmtradeUsd: "1800000.00",
        },
      },
    ],
  };
}

// ─────────────────────────────────────────── GET /stats/summary
// NO flash_v2 venue — only a combined "flash". All *Usd are decimal STRINGS.
function statsSummary(): StatsSummary {
  return {
    asOf: "2026-07-01T12:00:00.000Z",
    volume24hUsd: "24500000.50",
    volume7dUsd: "170000000.00",
    volumeAllUsd: "9800000000.00",
    openInterestUsd: "10700000.00",
    activeTraders24h: 1490,
    feeRevenue24hUsd: "42000.00",
    venues: [
      { venue: "flash", volumeUsd: "8500000.50", openInterestUsd: "5000000.00", traderCount: 700 },
      { venue: "jupiter", volumeUsd: "11000000.00", openInterestUsd: "0", traderCount: 480 },
      { venue: "phoenix", volumeUsd: "2700000.00", openInterestUsd: "3000000.00", traderCount: 210 },
      { venue: "gmtrade", volumeUsd: "2300000.00", openInterestUsd: "2700000.00", traderCount: 100 },
    ],
  };
}

/** Full, realistic input set. */
function fullInputs(): AggregateInputs {
  return {
    statsSummary: statsSummary(),
    statsMarkets: statsMarkets(),
    markPrices: markPrices(),
    fundingRates: fundingRates(),
    flashV2Markets: flashV2Markets(),
    flashMarkets: flashMarkets(),
    phoenixMarkets: phoenixMarkets(),
    gmtradeMarkets: gmtradeMarkets(),
    gmtradeLiquidity: gmtradeLiquidity(),
  };
}

/** Find one market by symbol in the aggregate output. */
function bySymbol(result: ReturnType<typeof aggregateMarkets>, symbol: string) {
  const m = result.markets.find((x) => x.symbol === symbol);
  if (!m) throw new Error(`expected market ${symbol} in output, got ${result.markets.map((x) => x.symbol).join(",")}`);
  return m;
}

// ════════════════════════════════════════════════════════════════════════
describe("normalizeUnderwriter", () => {
  it("maps flash_v2 and flash_trade to DISTINCT keys (not collapsed)", () => {
    expect(normalizeUnderwriter("flash_v2")).toBe("flash_v2");
    expect(normalizeUnderwriter("flash_trade")).toBe("flash");
    expect(normalizeUnderwriter("flash")).toBe("flash");
    // The critical guard: flash_v2 must NOT normalize to flash.
    expect(normalizeUnderwriter("flash_v2")).not.toBe(normalizeUnderwriter("flash_trade"));
  });

  it("maps the remaining venues and is case/space-insensitive", () => {
    expect(normalizeUnderwriter("phoenix")).toBe("phoenix");
    expect(normalizeUnderwriter("gmtrade")).toBe("gmtrade");
    expect(normalizeUnderwriter("jupiter")).toBe("jupiter");
    expect(normalizeUnderwriter("  FLASH_V2 ")).toBe("flash_v2");
  });

  it("returns null for unknown / nullish underwriters", () => {
    expect(normalizeUnderwriter("drift")).toBeNull();
    expect(normalizeUnderwriter(null)).toBeNull();
    expect(normalizeUnderwriter(undefined)).toBeNull();
  });
});

describe("resolveVenueFilter", () => {
  it("resolves flash_v2 aliases (incl. v2) to flash_v2", () => {
    for (const a of ["flash_v2", "flashv2", "flash-v2", "v2", "FLASH_V2", " v2 "]) {
      expect(resolveVenueFilter(a)).toBe("flash_v2");
    }
  });

  it("resolves flash (v1) aliases WITHOUT hitting flash_v2", () => {
    for (const a of ["flash", "flash_trade", "flashtrade", "flash-trade", "v1"]) {
      expect(resolveVenueFilter(a)).toBe("flash");
    }
    expect(resolveVenueFilter("v1")).not.toBe("flash_v2");
  });

  it("resolves phoenix / gmtrade / jupiter with aliases", () => {
    expect(resolveVenueFilter("phoenix")).toBe("phoenix");
    expect(resolveVenueFilter("gmtrade")).toBe("gmtrade");
    expect(resolveVenueFilter("gm")).toBe("gmtrade");
    expect(resolveVenueFilter("jupiter")).toBe("jupiter");
    expect(resolveVenueFilter("jup")).toBe("jupiter");
  });

  it("null/blank -> null (no filter); unknown -> undefined (restrict to nothing)", () => {
    expect(resolveVenueFilter(null)).toBeNull();
    expect(resolveVenueFilter(undefined)).toBeNull();
    expect(resolveVenueFilter("")).toBeNull();
    expect(resolveVenueFilter("   ")).toBeNull();
    expect(resolveVenueFilter("drift")).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("aggregateMarkets — 5-venue join", () => {
  it("joins all five venues by symbol and echoes period/asOf/source/venues[]", () => {
    const result = aggregateMarkets(fullInputs(), { period: "24h" });

    expect(result.asOf).toBe("2026-07-01T12:00:00.000Z");
    expect(result.period).toBe("24h");
    // No venue filter applied -> filter is null, count matches markets.
    expect(result.filter).toBeNull();
    expect(result.count).toBe(result.markets.length);
    // venues[] present, in canonical VENUE_ORDER.
    expect(result.venues).toEqual(["flash_v2", "flash", "phoenix", "gmtrade", "jupiter"]);
    // Canonical order sanity.
    expect(VENUE_ORDER).toEqual(["flash_v2", "flash", "phoenix", "gmtrade", "jupiter"]);
    // source reflects contributing reads.
    expect(result.source).toContain("stats/summary");
    expect(result.source).toContain("flash-v2/markets");
    expect(result.source).toContain("flash/markets");

    const sol = bySymbol(result, "SOL");
    // All five venues joined onto SOL.
    expect(Object.keys(sol.venues).sort()).toEqual(
      ["flash", "flash_v2", "gmtrade", "jupiter", "phoenix"].sort(),
    );

    // Top-level stats carried through (as STRINGS, unchanged).
    expect(sol.volumeUsd).toBe("9500000.50");
    expect(sol.openInterestUsd).toBe("3200000.00");
    expect(sol.longOiUsd).toBe("1800000.00");
    expect(sol.shortOiUsd).toBe("1400000.00");
    expect(sol.traderCount).toBe(812);
    expect(sol.positionCount).toBe(1340);
  });

  it("pulls flash_v2 leverage/fees/liquidity/maxSize from /flash-v2/markets ONLY", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");
    const v2 = sol.venues.flash_v2!;
    expect(v2).toBeDefined();
    expect(v2.available).toBe(true);
    expect(v2.maxLeverage).toBe(550);
    expect(v2.feeRate.openPosition).toBeCloseTo(0.0006);
    expect(v2.feeRate.closePosition).toBeCloseTo(0.0006);
    // Max across long/short sides.
    expect(v2.availableLiquidityUsd).toBe(4200000);
    expect(v2.maxPositionSizeUsd).toBe(1500000);
  });

  it("pulls flash (v1) leverage/fees + mark + funding + volume", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");
    const v1 = sol.venues.flash!;
    expect(v1).toBeDefined();
    expect(v1.available).toBe(true);
    expect(v1.maxLeverage).toBe(117);
    expect(v1.feeRate!.openPosition).toBeCloseTo(0.0008);
    expect(v1.feeRate!.volatility).toBeCloseTo(0.0001);
    // mark from mark-prices.flash
    expect(v1.markPrice).toBe(152.4);
    // funding + borrow from funding-rates.flash
    expect(v1.funding).toEqual({ long: 0.0012, short: -0.0009 });
    expect(v1.borrow).toEqual({ long: 0.0005, short: 0.0004 });
    // volume from byVenue.flashUsd (as string)
    expect(v1.volumeUsd).toBe("3500000.50");
  });

  it("pulls phoenix (leverage/fees/mark/funding/volume) and gmtrade (mark/funding/borrow/liquidity/closed/volume)", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");

    const phx = sol.venues.phoenix!;
    expect(phx.available).toBe(true);
    expect(phx.maxLeverage).toBe(10);
    expect(phx.feeRate).toEqual({ makerMicro: -200, takerMicro: 400 });
    expect(phx.markPrice).toBe(152.38);
    expect(phx.funding).toEqual({ long: 0.0001, short: -0.0001 });
    expect(phx.volumeUsd).toBe("1500000.00");

    const gm = sol.venues.gmtrade!;
    expect(gm.available).toBe(true);
    expect(gm.markPrice).toBe(152.41);
    // gmtrade funding here is null/null -> omitted; borrow present.
    expect(gm.funding).toBeUndefined();
    expect(gm.borrow).toEqual({ long: 0.0007, short: 0.0006 });
    expect(gm.liquidity).toEqual({ longAvailableUsd: 1200000, shortAvailableUsd: 950000 });
    expect(gm.closed).toBe(false);
    expect(gm.volumeUsd).toBe("500000.00");
  });

  it("carries jupiter as volume share only, and protocol totals from summary", () => {
    const result = aggregateMarkets(fullInputs());
    const sol = bySymbol(result, "SOL");
    // jupiter: only available + volumeUsd; nothing else exists on the object.
    expect(sol.venues.jupiter).toEqual({ available: true, volumeUsd: "4000000.00" });

    // totals from stats/summary (strings unchanged).
    expect(result.totals.volume24hUsd).toBe("24500000.50");
    expect(result.totals.volume7dUsd).toBe("170000000.00");
    expect(result.totals.volumeAllUsd).toBe("9800000000.00");
    expect(result.totals.openInterestUsd).toBe("10700000.00");
    expect(result.totals.activeTraders24h).toBe(1490);
    expect(result.totals.feeRevenue24hUsd).toBe("42000.00");

    // byVenue totals: summary has flash/jupiter/phoenix/gmtrade but NO flash_v2.
    expect(Object.keys(result.totals.byVenue).sort()).toEqual(
      ["flash", "gmtrade", "jupiter", "phoenix"].sort(),
    );
    expect(result.totals.byVenue.flash_v2).toBeUndefined();
    expect(result.totals.byVenue.flash).toEqual({
      volumeUsd: "8500000.50",
      openInterestUsd: "5000000.00",
      traderCount: 700,
    });
    expect(result.totals.byVenue.jupiter).toEqual({
      volumeUsd: "11000000.00",
      openInterestUsd: "0",
      traderCount: 480,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("aggregateMarkets — flash_v2 vs flash are SEPARATE objects", () => {
  it("SOL exposes flash_v2=550 and flash=117 as distinct venue objects", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");
    expect(sol.venues.flash_v2).toBeDefined();
    expect(sol.venues.flash).toBeDefined();
    expect(sol.venues.flash_v2!.maxLeverage).toBe(550);
    expect(sol.venues.flash!.maxLeverage).toBe(117);
    // Not the same object, and leverages genuinely differ.
    expect(sol.venues.flash_v2!.maxLeverage).not.toBe(sol.venues.flash!.maxLeverage);
  });

  it("BTC likewise: flash_v2=550 vs flash=100", () => {
    const btc = bySymbol(aggregateMarkets(fullInputs()), "BTC");
    expect(btc.venues.flash_v2!.maxLeverage).toBe(550);
    expect(btc.venues.flash!.maxLeverage).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("aggregateMarkets — no fabricated fields (honest attribution)", () => {
  it("flash_v2 venue object has NO markPrice/funding/volumeUsd, even though the `flash` keys exist", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");
    const v2 = sol.venues.flash_v2!;
    // Imperial exposes no v2 mark/funding/volume; these keys must be absent.
    expect("markPrice" in v2).toBe(false);
    expect("funding" in v2).toBe(false);
    expect("borrow" in v2).toBe(false);
    expect("volumeUsd" in v2).toBe(false);
    // The v2 object must NOT inherit v1's mark/funding/volume.
    expect((v2 as unknown as Record<string, unknown>).markPrice).toBeUndefined();
    // Sanity: those values DO exist on the v1 object, proving no cross-attribution.
    expect(sol.venues.flash!.markPrice).toBe(152.4);
    expect(sol.venues.flash!.volumeUsd).toBe("3500000.50");
  });

  it("gmtrade venue object has NO maxLeverage (Imperial exposes none)", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");
    expect("maxLeverage" in sol.venues.gmtrade!).toBe(false);
  });

  it("jupiter venue object exposes ONLY available + volumeUsd", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");
    expect(Object.keys(sol.venues.jupiter!).sort()).toEqual(["available", "volumeUsd"]);
    expect("markPrice" in sol.venues.jupiter!).toBe(false);
    expect("maxLeverage" in sol.venues.jupiter!).toBe(false);
  });

  it("flash_v2 with NO other data source still omits mark/funding for a v2-only symbol", () => {
    const wif = bySymbol(aggregateMarkets(fullInputs()), "WIF");
    expect(Object.keys(wif.venues)).toEqual(["flash_v2"]);
    const v2 = wif.venues.flash_v2!;
    expect("markPrice" in v2).toBe(false);
    expect("funding" in v2).toBe(false);
    expect("volumeUsd" in v2).toBe(false);
    // Stats absent for WIF -> top-level figures default to "0" strings, not fabricated.
    expect(wif.volumeUsd).toBe("0");
    expect(wif.openInterestUsd).toBe("0");
    expect(wif.traderCount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("aggregateMarkets — long/short dedupe", () => {
  it("collapses the two flash_v2 sides into one object, OR-ing availability and maxing leverage/liquidity", () => {
    const result = aggregateMarkets(fullInputs());
    // Exactly ONE flash_v2 entry per symbol (not two).
    const wif = bySymbol(result, "WIF");
    const v2 = wif.venues.flash_v2!;
    // long side allowOpenPosition=false, short side=true -> available true (OR).
    expect(v2.available).toBe(true);
    expect(v2.maxLeverage).toBe(22);
    // liquidity is max across sides (250000 vs 230000).
    expect(v2.availableLiquidityUsd).toBe(250000);
    expect(v2.maxPositionSizeUsd).toBe(75000);
  });

  it("collapses the two flash (v1) sides into one object with a single leverage", () => {
    const sol = bySymbol(aggregateMarkets(fullInputs()), "SOL");
    // Only one flash object; leverage 117 not duplicated.
    expect(sol.venues.flash!.maxLeverage).toBe(117);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("aggregateMarkets — venue filter", () => {
  it('venue="flash_v2" -> ONLY flash_v2, drops markets that lack it', () => {
    const result = aggregateMarkets(fullInputs(), { venue: "flash_v2" });
    expect(result.venues).toEqual(["flash_v2"]);
    // Filter is echoed (normalized) + count matches, so a consumer can tell a
    // filtered response apart from "that's all the data there is".
    expect(result.filter).toBe("flash_v2");
    expect(result.count).toBe(result.markets.length);
    // Every emitted market has ONLY a flash_v2 venue view.
    for (const m of result.markets) {
      expect(Object.keys(m.venues)).toEqual(["flash_v2"]);
    }
    // ETH has no flash_v2 (only phoenix/gmtrade) -> dropped.
    expect(result.markets.map((m) => m.symbol).sort()).toEqual(["BTC", "SOL", "WIF"]);
    // totals.byVenue restricted (flash_v2 not in summary -> empty byVenue).
    expect(result.totals.byVenue).toEqual({});
  });

  it('alias venue="v2" behaves identically to flash_v2', () => {
    const a = aggregateMarkets(fullInputs(), { venue: "v2" });
    const b = aggregateMarkets(fullInputs(), { venue: "flash_v2" });
    expect(a.venues).toEqual(b.venues);
    expect(a.markets.map((m) => m.symbol)).toEqual(b.markets.map((m) => m.symbol));
  });

  it('venue="flash" -> ONLY v1 (NOT flash_v2), keeps v1 leverage 117 & drops flash_v2', () => {
    const result = aggregateMarkets(fullInputs(), { venue: "flash" });
    expect(result.venues).toEqual(["flash"]);
    for (const m of result.markets) {
      expect(Object.keys(m.venues)).toEqual(["flash"]);
      expect(m.venues.flash_v2).toBeUndefined();
    }
    // SOL kept, at v1 leverage (117) — proving v2's 550 was NOT selected.
    const sol = bySymbol(result, "SOL");
    expect(sol.venues.flash!.maxLeverage).toBe(117);
    // WIF is flash_v2-only -> dropped under a flash(v1) filter.
    expect(result.markets.map((m) => m.symbol)).not.toContain("WIF");
    // byVenue restricted to flash only.
    expect(Object.keys(result.totals.byVenue)).toEqual(["flash"]);
  });

  it('venue="jupiter" -> ONLY jupiter; drops markets with NO jupiter volume string at all', () => {
    const result = aggregateMarkets(fullInputs(), { venue: "jupiter" });
    expect(result.venues).toEqual(["jupiter"]);
    // Every market with a jupiterUsd string (incl. "0") is kept; WIF (no stats
    // row, hence no byVenue) is dropped. SOL/BTC/ETH all have a jupiterUsd.
    expect(result.markets.map((m) => m.symbol).sort()).toEqual(["BTC", "ETH", "SOL"]);
    expect(result.markets.map((m) => m.symbol)).not.toContain("WIF");
    for (const m of result.markets) {
      expect(Object.keys(m.venues)).toEqual(["jupiter"]);
    }
    // ETH carries the literal "0" string — surfaced honestly, not dropped/faked.
    expect(bySymbol(result, "ETH").venues.jupiter!.volumeUsd).toBe("0");
  });

  it("unknown venue filter -> restrict to nothing (empty markets & venues)", () => {
    const result = aggregateMarkets(fullInputs(), { venue: "drift" });
    expect(result.venues).toEqual([]);
    expect(result.markets).toEqual([]);
    expect(result.totals.byVenue).toEqual({});
    // Totals headline still comes through (they're protocol-wide, not venue-gated).
    expect(result.totals.volume24hUsd).toBe("24500000.50");
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("aggregateMarkets — graceful degradation (nullable inputs, never throws)", () => {
  it("flashV2Markets=null -> no flash_v2 anywhere, other venues intact", () => {
    const inputs = { ...fullInputs(), flashV2Markets: null };
    const result = aggregateMarkets(inputs);
    expect(result.venues).not.toContain("flash_v2");
    const sol = bySymbol(result, "SOL");
    expect(sol.venues.flash_v2).toBeUndefined();
    // v1 flash still present & correct.
    expect(sol.venues.flash!.maxLeverage).toBe(117);
    // WIF was flash_v2-only -> without it, WIF disappears entirely.
    expect(result.markets.map((m) => m.symbol)).not.toContain("WIF");
  });

  it("markPrices=null -> markPrice omitted, funding/leverage/volume unaffected", () => {
    const inputs = { ...fullInputs(), markPrices: null };
    const result = aggregateMarkets(inputs);
    const sol = bySymbol(result, "SOL");
    expect("markPrice" in sol.venues.flash!).toBe(false);
    expect("markPrice" in sol.venues.phoenix!).toBe(false);
    expect("markPrice" in sol.venues.gmtrade!).toBe(false);
    // funding still present.
    expect(sol.venues.flash!.funding).toEqual({ long: 0.0012, short: -0.0009 });
    // leverage still present.
    expect(sol.venues.flash!.maxLeverage).toBe(117);
  });

  it("fundingRates=null -> funding/borrow omitted, marks still present", () => {
    const inputs = { ...fullInputs(), fundingRates: null };
    const sol = bySymbol(aggregateMarkets(inputs), "SOL");
    expect("funding" in sol.venues.flash!).toBe(false);
    expect("borrow" in sol.venues.flash!).toBe(false);
    expect(sol.venues.flash!.markPrice).toBe(152.4);
  });

  it("statsSummary=null -> totals default to zeros, empty byVenue, deterministic asOf fallback", () => {
    const inputs = { ...fullInputs(), statsSummary: null };
    const result = aggregateMarkets(inputs);
    expect(result.totals.volume24hUsd).toBe("0");
    expect(result.totals.activeTraders24h).toBe(0);
    expect(result.totals.byVenue).toEqual({});
    // No ambient clock: fallback is the epoch, not "now".
    expect(result.asOf).toBe(new Date(0).toISOString());
    // Markets still join from the other venues.
    expect(result.markets.length).toBeGreaterThan(0);
  });

  it("statsMarkets=null -> per-market stats default to '0' but venue data still joins", () => {
    const inputs = { ...fullInputs(), statsMarkets: null };
    const result = aggregateMarkets(inputs);
    const sol = bySymbol(result, "SOL");
    expect(sol.volumeUsd).toBe("0");
    expect(sol.openInterestUsd).toBe("0");
    // No byVenue -> no per-venue volumeUsd, and jupiter (stats-only) vanishes.
    expect("volumeUsd" in sol.venues.flash!).toBe(false);
    expect(sol.venues.jupiter).toBeUndefined();
    // But leverage/mark/funding still present from other reads.
    expect(sol.venues.flash!.maxLeverage).toBe(117);
    expect(sol.venues.flash!.markPrice).toBe(152.4);
  });

  it("null / undefined / empty inputs -> valid empty-ish payload, never throws", () => {
    for (const input of [null, undefined, {}]) {
      const result = aggregateMarkets(input as never);
      expect(result.markets).toEqual([]);
      expect(result.venues).toEqual([]);
      expect(result.totals.byVenue).toEqual({});
      expect(result.totals.volume24hUsd).toBe("0");
      expect(result.asOf).toBe(new Date(0).toISOString());
      expect(result.source).toBe("imperial");
      expect(result.period).toBe("");
    }
  });

  it("ALL fields explicitly null -> valid empty-ish payload", () => {
    const allNull: AggregateInputs = {
      statsSummary: null,
      statsMarkets: null,
      markPrices: null,
      fundingRates: null,
      flashV2Markets: null,
      flashMarkets: null,
      phoenixMarkets: null,
      gmtradeMarkets: null,
      gmtradeLiquidity: null,
    };
    const result = aggregateMarkets(allNull);
    expect(result.markets).toEqual([]);
    expect(result.venues).toEqual([]);
    expect(result.totals).toEqual({
      volume24hUsd: "0",
      volume7dUsd: "0",
      volumeAllUsd: "0",
      openInterestUsd: "0",
      activeTraders24h: 0,
      feeRevenue24hUsd: "0",
      byVenue: {},
    });
  });

  it("malformed (non-array) venue market lists are coerced, not thrown", () => {
    const inputs = {
      ...fullInputs(),
      flashV2Markets: "not-an-array" as unknown as FlashV2Market[],
      phoenixMarkets: 42 as unknown as PhoenixMarket[],
    };
    const result = aggregateMarkets(inputs);
    // Bad lists simply contribute nothing; no crash.
    expect(result.markets.length).toBeGreaterThan(0);
    const sol = bySymbol(result, "SOL");
    // flash_v2 had NO other data source -> gone entirely with a broken list.
    expect(sol.venues.flash_v2).toBeUndefined();
    // phoenix market list is broken, but phoenix mark/funding/volume still
    // arrive from the OTHER (valid) reads, so the venue view survives — WITHOUT
    // leverage/fees (omitted rather than a misleading 0), just the live price.
    expect(sol.venues.phoenix).toBeDefined();
    expect(sol.venues.phoenix!.maxLeverage).toBeUndefined();
    expect(sol.venues.phoenix!.feeRate).toBeUndefined();
    expect(sol.venues.phoenix!.markPrice).toBe(152.38);
    // flash (v1) still there.
    expect(sol.venues.flash).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("aggregateMarkets — symbol keys & union universe", () => {
  it("uppercases symbol keys regardless of source casing", () => {
    const inputs: AggregateInputs = {
      ...fullInputs(),
      flashV2Markets: [
        {
          symbol: "sol", // lowercase from source
          side: "long",
          underwriter: "flash_v2",
          marketAddress: "x",
          targetMint: "y",
          maxLeverage: 550,
          openPositionFeeRate: 0.0006,
          closePositionFeeRate: 0.0006,
          availableLiquidityUsd: 1,
          maxPositionSizeUsd: 1,
          allowOpenPosition: true,
          pythLazerSymbol: "SOL/USD",
          schedule: null,
        },
      ],
    };
    const result = aggregateMarkets(inputs);
    // The lowercase "sol" folds into the uppercase "SOL" bucket.
    expect(result.markets.every((m) => m.symbol === m.symbol.toUpperCase())).toBe(true);
    const sol = result.markets.find((m) => m.symbol === "SOL");
    expect(sol).toBeDefined();
    expect(result.markets.find((m) => m.symbol === "sol")).toBeUndefined();
  });

  it("builds the symbol universe as a UNION across stats + all venue market lists + mark/funding", () => {
    // WIF exists ONLY in flash_v2; ETH only in phoenix/gmtrade/stats; BTC in
    // flash_v2/flash/stats/mark/funding; SOL everywhere. Universe = union.
    const result = aggregateMarkets(fullInputs());
    const symbols = result.markets.map((m) => m.symbol).sort();
    expect(symbols).toEqual(["BTC", "ETH", "SOL", "WIF"]);
  });

  it("sorts markets by 24h volume desc, then symbol asc", () => {
    const result = aggregateMarkets(fullInputs());
    const symbols = result.markets.map((m) => m.symbol);
    // BTC(12M) > SOL(9.5M) > ETH(3M) > WIF(0, no stats).
    expect(symbols).toEqual(["BTC", "SOL", "ETH", "WIF"]);
  });
});
