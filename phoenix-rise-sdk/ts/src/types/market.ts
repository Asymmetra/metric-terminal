import z from "zod";
import { type TokenAmount, TokenAmountSchema } from "@/primitives/TokenAmount";
import { type Symbol, symbol } from "@/primitives/Symbol";

const zSymbol = z.string().transform(symbol);

// ---------------------------------------------------------------------------
// Market sub-types
// ---------------------------------------------------------------------------

export interface MarketUnits {
  tickSizeInQuoteLotsPerBaseLot: number;
  baseLotsDecimals: number;
}

export const MarketUnitsSchema: z.ZodType<MarketUnits> = z.object({
  tickSizeInQuoteLotsPerBaseLot: z.number(),
  baseLotsDecimals: z.number(),
});

export interface MarketFees {
  takerFeeMicro: number;
  makerFeeMicro: number;
}

export const MarketFeesSchema: z.ZodType<MarketFees> = z.object({
  takerFeeMicro: z.number(),
  // Older payloads may omit maker fees; default to 0 for compatibility
  makerFeeMicro: z.number().default(0).catch(0),
});

export interface MarketLeverageTier {
  maxLeverage: number;
  maxSizeBaseLots: number;
  limitOrderRiskFactor: number;
}

export const LeverageTierSchema: z.ZodType<MarketLeverageTier> = z.object({
  maxLeverage: z.number(),
  maxSizeBaseLots: z.number(),
  // Older API payloads may omit this; default to 0 for backward compatibility.
  limitOrderRiskFactor: z.number().default(0).catch(0),
});

export interface RiskFactors {
  maintenance: number;
  backstop: number;
  highRisk: number;
  upnl: number;
  upnlForWithdrawals: number;
  cancelOrder: number;
}

export const RiskFactorsSchema: z.ZodType<RiskFactors> = z.object({
  maintenance: z.number(),
  backstop: z.number(),
  highRisk: z.number(),
  // Added fields default to 0 to tolerate older server responses/fixtures
  upnl: z.number().default(0).catch(0),
  upnlForWithdrawals: z.number().default(0).catch(0),
  cancelOrder: z.number().default(0).catch(0),
});

// ---------------------------------------------------------------------------
// MarketSummary (matches ts/sdk MarketSummary)
// ---------------------------------------------------------------------------

export interface MarketSummary {
  symbol: Symbol;
  assetId: number;
  marketStatus: string;
  units: MarketUnits;
  fees: MarketFees;
  openInterest: TokenAmount;
  openInterestCap: TokenAmount;
  leverageTiers: MarketLeverageTier[];
  fundingIntervalInSlots: number;
  fundingPeriodInSlots: number;
  fundingStartIntervalSlot: number;
  cumulativeFundingRate: number;
  maxLiquidationSize: TokenAmount;
  riskFactors: RiskFactors;
  isolatedOnly: boolean;
}

export const MarketSummarySchema: z.ZodType<MarketSummary> = z.object({
  symbol: zSymbol,
  assetId: z.number(),
  marketStatus: z.string(),
  units: MarketUnitsSchema,
  fees: MarketFeesSchema,
  openInterest: TokenAmountSchema,
  openInterestCap: TokenAmountSchema,
  leverageTiers: z.array(LeverageTierSchema),
  fundingIntervalInSlots: z.number(),
  fundingPeriodInSlots: z.number(),
  fundingStartIntervalSlot: z.number(),
  cumulativeFundingRate: z.number(),
  maxLiquidationSize: TokenAmountSchema,
  riskFactors: RiskFactorsSchema,
  isolatedOnly: z.boolean(),
});

// ---------------------------------------------------------------------------
// MarketsResponse (matches ts/sdk MarketsResponse)
// ---------------------------------------------------------------------------

export interface MarketsResponse {
  slot: number;
  markets: MarketSummary[];
}

export const MarketsResponseSchema: z.ZodType<MarketsResponse> = z.object({
  slot: z.number(),
  markets: z.array(MarketSummarySchema),
});
