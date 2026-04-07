import type { HttpTransport } from "@/http/transport";
import { get } from "@/http/transport";
import type {
  ExchangeConfig,
  ExchangeKeys,
  ExchangeMarketConfig,
  ExchangeStatusView,
} from "./types";
import {
  ExchangeConfigSchema,
  ExchangeKeysSchema,
  ExchangeMarketConfigSchema,
  ExchangeStatusViewSchema,
} from "./types";

export class V1ExchangeClient {
  constructor(private http: HttpTransport) {}

  async getExchange(): Promise<ExchangeConfig> {
    return get(this.http, "/exchange", ExchangeConfigSchema);
  }

  async getMarket(symbol: string): Promise<ExchangeMarketConfig> {
    return get(
      this.http,
      `/exchange/market/${encodeURIComponent(symbol)}`,
      ExchangeMarketConfigSchema
    );
  }

  async getStatus(): Promise<ExchangeStatusView> {
    return get(this.http, "/exchange/status", ExchangeStatusViewSchema);
  }

  async getKeys(): Promise<ExchangeKeys> {
    return get(this.http, "/exchange/keys", ExchangeKeysSchema);
  }

  async getMarkets(): Promise<ExchangeMarketConfig[]> {
    return get(
      this.http,
      "/exchange/markets",
      ExchangeMarketConfigSchema.array()
    );
  }
}
