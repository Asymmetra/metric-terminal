import { describe, it, expect } from "vitest";
import {
  aggregatePairs,
  type PairsFundingRates,
} from "./pairs-aggregate";
import type { PairsMarketRow } from "./types";

/**
 * REALISTIC fixtures built directly from the live Imperial read shapes
 * (verified 2026-08-03). Everything below mirrors what Imperial actually
 * returns — no fabricated fields.
 *
 * KEY facts these fixtures encode:
 *   - GET /pairs/markets returns TWO rows per symbol (one long, one short) with
 *     identical leverage/fee/liquidity; `kind` is "pair_geometric" | "single_feed".
 *   - underwriter is always the string "pairs".
 *   - GET /funding-rates rows MAY carry an optional `pairs` slice
 *     (source "pairs_onchain_funding"); many symbols have none.
 */

// ─────────────────────────────────────────── GET /pairs/markets
// TWO entries per symbol (long + short). Values mirror the live payload.
function pairsMarkets(): PairsMarketRow[] {
  return [
    // SOLBTC — a geometric pair, very high leverage, deepest liquidity.
    {
      symbol: "SOLBTC",
      kind: "pair_geometric",
      marketId: 0,
      side: "long",
      underwriter: "pairs",
      marketAddress: "2XPaUSz89iZMjAWPeMAVFumuPAPCpPCLorWsucxZfyAM",
      targetMint: "2XPaUSz89iZMjAWPeMAVFumuPAPCpPCLorWsucxZfyAM",
      maxLeverage: 100.0,
      maxOpenableLeverage: 99.65,
      openPositionFeeRate: 0.0,
      closePositionFeeRate: 0.0005,
      impactFeeRate: 0.0,
      availableLiquidityUsd: 48934.2,
      allowOpenPosition: true,
    },
    {
      symbol: "SOLBTC",
      kind: "pair_geometric",
      marketId: 0,
      side: "short",
      underwriter: "pairs",
      marketAddress: "2XPaUSz89iZMjAWPeMAVFumuPAPCpPCLorWsucxZfyAM",
      targetMint: "2XPaUSz89iZMjAWPeMAVFumuPAPCpPCLorWsucxZfyAM",
      maxLeverage: 100.0,
      maxOpenableLeverage: 99.65,
      openPositionFeeRate: 0.0,
      closePositionFeeRate: 0.0005,
      impactFeeRate: 0.0,
      availableLiquidityUsd: 48934.2,
      allowOpenPosition: true,
    },
    // ANSEM — a single-feed market, joined to funding-rates.pairs below.
    {
      symbol: "ANSEM",
      kind: "single_feed",
      marketId: 1,
      side: "long",
      underwriter: "pairs",
      marketAddress: "J6qsBCE6nHyNqEtx9r3gTAa1n62rq3hpeS6ndQU7Fm7x",
      targetMint: "J6qsBCE6nHyNqEtx9r3gTAa1n62rq3hpeS6ndQU7Fm7x",
      maxLeverage: 10.0,
      maxOpenableLeverage: 6.46,
      openPositionFeeRate: 0.0045,
      closePositionFeeRate: 0.0045,
      impactFeeRate: 0.05,
      availableLiquidityUsd: 1976.86,
      allowOpenPosition: true,
    },
    {
      symbol: "ANSEM",
      kind: "single_feed",
      marketId: 1,
      side: "short",
      underwriter: "pairs",
      marketAddress: "J6qsBCE6nHyNqEtx9r3gTAa1n62rq3hpeS6ndQU7Fm7x",
      targetMint: "J6qsBCE6nHyNqEtx9r3gTAa1n62rq3hpeS6ndQU7Fm7x",
      maxLeverage: 10.0,
      maxOpenableLeverage: 6.46,
      openPositionFeeRate: 0.0045,
      closePositionFeeRate: 0.0045,
      impactFeeRate: 0.05,
      availableLiquidityUsd: 1976.86,
      // Short side closed while long remains open — folds to allowOpen{long:true,short:false}.
      allowOpenPosition: false,
    },
    // CASHCAT — single-feed, no funding-rates.pairs slice (funding omitted).
    {
      symbol: "CASHCAT",
      kind: "single_feed",
      marketId: 2,
      side: "long",
      underwriter: "pairs",
      marketAddress: "EAXXcwBbzgU4qJDHx7EgZg7eka4MALurp99GJNMdU7vT",
      targetMint: "EAXXcwBbzgU4qJDHx7EgZg7eka4MALurp99GJNMdU7vT",
      maxLeverage: 10.0,
      maxOpenableLeverage: 6.28,
      openPositionFeeRate: 0.009,
      closePositionFeeRate: 0.009,
      impactFeeRate: 0.05,
      availableLiquidityUsd: 1950.0,
      allowOpenPosition: true,
    },
    {
      symbol: "CASHCAT",
      kind: "single_feed",
      marketId: 2,
      side: "short",
      underwriter: "pairs",
      marketAddress: "EAXXcwBbzgU4qJDHx7EgZg7eka4MALurp99GJNMdU7vT",
      targetMint: "EAXXcwBbzgU4qJDHx7EgZg7eka4MALurp99GJNMdU7vT",
      maxLeverage: 10.0,
      maxOpenableLeverage: 6.28,
      openPositionFeeRate: 0.009,
      closePositionFeeRate: 0.009,
      impactFeeRate: 0.05,
      availableLiquidityUsd: 1950.0,
      allowOpenPosition: true,
    },
  ];
}

// ─────────────────────────────────────────── GET /funding-rates
// Only SOLBTC + ANSEM carry a `pairs` slice; CASHCAT has none. Other venue
// keys (phoenix, etc.) are present on real rows but ignored by the aggregate.
function fundingRates(): PairsFundingRates {
  return {
    rows: [
      {
        symbol: "SOLBTC",
        pairs: {
          source: "pairs_onchain_funding",
          longFundingRatePerHourPercent: 0.0012,
          shortFundingRatePerHourPercent: -0.0012,
          longBorrowRatePerHourPercent: null,
          shortBorrowRatePerHourPercent: null,
        },
      },
      {
        symbol: "ANSEM",
        pairs: {
          source: "pairs_onchain_funding",
          longFundingRatePerHourPercent: 0.00642744,
          shortFundingRatePerHourPercent: -0.00642744,
          longBorrowRatePerHourPercent: null,
          shortBorrowRatePerHourPercent: null,
        },
      },
      // CASHCAT: no `pairs` slice at all.
      { symbol: "CASHCAT" },
    ],
  };
}

const ASOF = "2026-08-03T00:00:00.000Z";

describe("aggregatePairs — long/short fold into one row", () => {
  it("collapses the long+short rows per symbol into a single object", () => {
    const out = aggregatePairs(
      { pairsMarkets: pairsMarkets(), fundingRates: fundingRates() },
      { asOf: ASOF },
    );

    // 6 input rows (3 symbols × 2 sides) → 3 folded markets.
    expect(out.count).toBe(3);
    expect(out.markets).toHaveLength(3);

    const solbtc = out.markets.find((m) => m.symbol === "SOLBTC");
    expect(solbtc).toBeDefined();
    expect(solbtc).toMatchObject({
      symbol: "SOLBTC",
      kind: "pair_geometric",
      marketId: 0,
      maxLeverage: 100,
      maxOpenableLeverage: 99.65,
      availableLiquidityUsd: 48934.2,
      feeRate: { openPosition: 0, closePosition: 0.0005, impact: 0 },
      allowOpen: { long: true, short: true },
    });
  });

  it("ORs per-side allowOpenPosition into allowOpen.{long,short}", () => {
    const out = aggregatePairs(
      { pairsMarkets: pairsMarkets(), fundingRates: null },
      { asOf: ASOF },
    );
    const ansem = out.markets.find((m) => m.symbol === "ANSEM");
    // ANSEM long allows, short is closed in the fixture.
    expect(ansem?.allowOpen).toEqual({ long: true, short: false });
  });
});

describe("aggregatePairs — funding joined from funding-rates.pairs", () => {
  it("attaches the pairs funding slice by symbol", () => {
    const out = aggregatePairs(
      { pairsMarkets: pairsMarkets(), fundingRates: fundingRates() },
      { asOf: ASOF },
    );

    const ansem = out.markets.find((m) => m.symbol === "ANSEM");
    expect(ansem?.funding).toEqual({
      funding: { long: 0.00642744, short: -0.00642744 },
    });
    // borrow is null/null in the fixture → omitted entirely.
    expect(ansem?.funding?.borrow).toBeUndefined();
  });

  it("omits funding for symbols with no pairs slice", () => {
    const out = aggregatePairs(
      { pairsMarkets: pairsMarkets(), fundingRates: fundingRates() },
      { asOf: ASOF },
    );
    const cashcat = out.markets.find((m) => m.symbol === "CASHCAT");
    expect(cashcat).toBeDefined();
    expect(cashcat).not.toHaveProperty("funding");
  });

  it("joins BOTH funding and borrow when the pairs slice provides borrow rates", () => {
    const out = aggregatePairs(
      {
        pairsMarkets: pairsMarkets(),
        fundingRates: {
          rows: [
            {
              symbol: "SOLBTC",
              pairs: {
                source: "pairs_onchain_funding",
                longFundingRatePerHourPercent: 0.0012,
                shortFundingRatePerHourPercent: -0.0012,
                longBorrowRatePerHourPercent: 0.003,
                shortBorrowRatePerHourPercent: 0.001,
              },
            },
          ],
        },
      },
      { asOf: ASOF },
    );
    const solbtc = out.markets.find((m) => m.symbol === "SOLBTC");
    expect(solbtc?.funding).toEqual({
      funding: { long: 0.0012, short: -0.0012 },
      borrow: { long: 0.003, short: 0.001 },
    });
  });
});

describe("aggregatePairs — graceful degradation (nullable inputs, never throws)", () => {
  it("returns a valid empty aggregate when both inputs are null", () => {
    const out = aggregatePairs({ pairsMarkets: null, fundingRates: null }, { asOf: ASOF });
    expect(out.count).toBe(0);
    expect(out.markets).toEqual([]);
    expect(out.source).toBe("imperial");
    expect(out.asOf).toBe(ASOF);
  });

  it("returns a valid empty aggregate for null/undefined inputs object", () => {
    expect(() => aggregatePairs(null)).not.toThrow();
    expect(() => aggregatePairs(undefined)).not.toThrow();
    const out = aggregatePairs(null);
    expect(out.count).toBe(0);
    expect(out.markets).toEqual([]);
    // Deterministic epoch fallback — no ambient clock.
    expect(out.asOf).toBe(new Date(0).toISOString());
  });

  it("folds markets fine when fundingRates is null (funding simply omitted)", () => {
    const out = aggregatePairs(
      { pairsMarkets: pairsMarkets(), fundingRates: null },
      { asOf: ASOF },
    );
    expect(out.count).toBe(3);
    expect(out.source).toBe("imperial:pairs/markets");
    for (const m of out.markets) expect(m).not.toHaveProperty("funding");
  });

  it("still runs (no markets) when only fundingRates is present", () => {
    const out = aggregatePairs(
      { pairsMarkets: null, fundingRates: fundingRates() },
      { asOf: ASOF },
    );
    expect(out.count).toBe(0);
    expect(out.markets).toEqual([]);
    expect(out.source).toBe("imperial:funding-rates");
  });

  it("tolerates malformed rows (missing symbol) without throwing", () => {
    const malformed = [
      { symbol: "", side: "long" } as unknown as PairsMarketRow,
      // A row that is genuinely valid should still survive.
      pairsMarkets()[0],
    ];
    const out = aggregatePairs({ pairsMarkets: malformed, fundingRates: null }, { asOf: ASOF });
    expect(out.count).toBe(1);
    expect(out.markets[0].symbol).toBe("SOLBTC");
  });
});

describe("aggregatePairs — no fabricated fields", () => {
  it("emits only the folded fields Imperial actually returns", () => {
    const out = aggregatePairs(
      { pairsMarkets: pairsMarkets(), fundingRates: fundingRates() },
      { asOf: ASOF },
    );
    const solbtc = out.markets.find((m) => m.symbol === "SOLBTC")!;
    // Exact key set — nothing invented (marketAddress/targetMint/underwriter/side
    // are intentionally NOT surfaced).
    expect(Object.keys(solbtc).sort()).toEqual(
      [
        "allowOpen",
        "availableLiquidityUsd",
        "feeRate",
        "funding",
        "kind",
        "marketId",
        "maxLeverage",
        "maxOpenableLeverage",
        "symbol",
      ].sort(),
    );
    expect(Object.keys(solbtc.feeRate).sort()).toEqual(
      ["closePosition", "impact", "openPosition"].sort(),
    );
  });
});

describe("aggregatePairs — sorted by liquidity", () => {
  it("orders markets by availableLiquidityUsd descending", () => {
    const out = aggregatePairs(
      { pairsMarkets: pairsMarkets(), fundingRates: fundingRates() },
      { asOf: ASOF },
    );
    const liq = out.markets.map((m) => m.availableLiquidityUsd);
    // SOLBTC (48934.2) > CASHCAT/ANSEM. Verify it is non-increasing.
    for (let i = 1; i < liq.length; i++) {
      expect(liq[i - 1]).toBeGreaterThanOrEqual(liq[i]);
    }
    expect(out.markets[0].symbol).toBe("SOLBTC");
  });

  it("breaks ties alphabetically by symbol", () => {
    // ANSEM (1976.86) vs CASHCAT (1950.0): ANSEM has more liquidity so it wins;
    // give them equal liquidity to exercise the alpha tiebreak.
    const rows = pairsMarkets().map((r) =>
      r.symbol === "CASHCAT" ? { ...r, availableLiquidityUsd: 1976.86 } : r,
    );
    const out = aggregatePairs({ pairsMarkets: rows, fundingRates: null }, { asOf: ASOF });
    const tied = out.markets.filter((m) => m.availableLiquidityUsd === 1976.86).map((m) => m.symbol);
    expect(tied).toEqual(["ANSEM", "CASHCAT"]);
  });
});
