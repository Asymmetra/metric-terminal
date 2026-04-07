import z from "zod";

// ---------------------------------------------------------------------------
// Authority Set
// ---------------------------------------------------------------------------

export interface AuthoritySet {
  rootAuthority: string;
  riskAuthority: string;
  marketAuthority: string;
  oracleAuthority: string;
  adlAuthority: string;
  cancelAuthority: string;
  backstopAuthority: string;
}

export const AuthoritySetSchema: z.ZodType<AuthoritySet> = z.object({
  rootAuthority: z.string(),
  riskAuthority: z.string(),
  marketAuthority: z.string(),
  oracleAuthority: z.string(),
  adlAuthority: z.string(),
  cancelAuthority: z.string(),
  backstopAuthority: z.string(),
});

// ---------------------------------------------------------------------------
// Exchange Keys
// ---------------------------------------------------------------------------

export interface ExchangeKeys {
  globalConfig: string;
  currentAuthorities: AuthoritySet;
  pendingAuthorities: AuthoritySet;
  canonicalMint: string;
  globalVault: string;
  perpAssetMap: string;
  globalTraderIndex: string[];
  activeTraderBuffer: string[];
  withdrawQueue: string;
}

export const ExchangeKeysSchema: z.ZodType<ExchangeKeys> = z.object({
  globalConfig: z.string(),
  currentAuthorities: AuthoritySetSchema,
  pendingAuthorities: AuthoritySetSchema,
  canonicalMint: z.string(),
  globalVault: z.string(),
  perpAssetMap: z.string(),
  globalTraderIndex: z.array(z.string()),
  activeTraderBuffer: z.array(z.string()),
  withdrawQueue: z.string(),
});

// ---------------------------------------------------------------------------
// Exchange Status View
// ---------------------------------------------------------------------------

export interface ExchangeStatusView {
  active: boolean;
  gated: boolean;
}

export const ExchangeStatusViewSchema: z.ZodType<ExchangeStatusView> = z.object(
  {
    active: z.boolean(),
    gated: z.boolean(),
  }
);

// ---------------------------------------------------------------------------
// Exchange Market Config
// ---------------------------------------------------------------------------

export interface ExchangeLeverageTier {
  maxLeverage: number;
  maxSizeBaseLots: number;
  limitOrderRiskFactor: number;
}

export const ExchangeLeverageTierSchema: z.ZodType<ExchangeLeverageTier> =
  z.object({
    maxLeverage: z.number(),
    maxSizeBaseLots: z.number(),
    limitOrderRiskFactor: z.number(),
  });

export interface ExchangeRiskFactors {
  maintenance: number;
  backstop: number;
  highRisk: number;
  upnl: number;
  upnlForWithdrawals: number;
  cancelOrder: number;
}

export const ExchangeRiskFactorsSchema: z.ZodType<ExchangeRiskFactors> =
  z.object({
    maintenance: z.number(),
    backstop: z.number(),
    highRisk: z.number(),
    upnl: z.number(),
    upnlForWithdrawals: z.number(),
    cancelOrder: z.number(),
  });

export interface ExchangeMarketConfig {
  symbol: string;
  assetId: number;
  marketStatus: string;
  marketPubkey: string;
  splinePubkey: string;
  tickSize: number;
  baseLotsDecimals: number;
  takerFee: number;
  makerFee: number;
  leverageTiers: ExchangeLeverageTier[];
  riskFactors: ExchangeRiskFactors;
  fundingIntervalSeconds: number;
  fundingPeriodSeconds: number;
  maxFundingRatePerInterval: number;
  openInterestCapBaseLots: string;
  maxLiquidationSizeBaseLots: string;
  isolatedOnly: boolean;
}

export const ExchangeMarketConfigSchema: z.ZodType<ExchangeMarketConfig> =
  z.object({
    symbol: z.string(),
    assetId: z.number(),
    marketStatus: z.string(),
    marketPubkey: z.string(),
    splinePubkey: z.string(),
    tickSize: z.number(),
    baseLotsDecimals: z.number(),
    takerFee: z.number(),
    makerFee: z.number(),
    leverageTiers: z.array(ExchangeLeverageTierSchema),
    riskFactors: ExchangeRiskFactorsSchema,
    fundingIntervalSeconds: z.number(),
    fundingPeriodSeconds: z.number(),
    maxFundingRatePerInterval: z.number(),
    openInterestCapBaseLots: z
      .union([z.string(), z.number()])
      .transform(String),
    maxLiquidationSizeBaseLots: z
      .union([z.string(), z.number()])
      .transform(String),
    isolatedOnly: z.boolean(),
  });

// ---------------------------------------------------------------------------
// Exchange View (full config response)
// ---------------------------------------------------------------------------

export interface ExchangeConfig {
  keys: ExchangeKeys;
  markets: ExchangeMarketConfig[];
}

export const ExchangeConfigSchema: z.ZodType<ExchangeConfig> = z.object({
  keys: ExchangeKeysSchema,
  markets: z.array(ExchangeMarketConfigSchema),
});
