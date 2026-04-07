import type { HttpTransport } from "@/http/transport";
import { get } from "@/http/transport";
import type { ExchangeMarketConfig } from "@/api/exchange";
import { ExchangeMarketConfigSchema } from "@/api/exchange";

export class V1MarketsClient {
  constructor(private http: HttpTransport) {}

  async getMarkets(): Promise<ExchangeMarketConfig[]> {
    return get(
      this.http,
      "/exchange/markets",
      ExchangeMarketConfigSchema.array()
    );
  }

  async getMarket(symbol: string): Promise<ExchangeMarketConfig> {
    return get(
      this.http,
      `/exchange/market/${encodeURIComponent(symbol)}`,
      ExchangeMarketConfigSchema
    );
  }
}
