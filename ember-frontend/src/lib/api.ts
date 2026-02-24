import { API_BASE_URL } from "./constants";

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

export const api = {
  getMarkets: () => fetchApi<any[]>("/api/markets"),
  getMarket: (symbol: string) => fetchApi<any>(`/api/markets/${symbol}`),
  getOrderbook: (symbol: string) => fetchApi<any>(`/api/orderbook/${symbol}`),
  getCandles: (symbol: string, timeframe = "1m", limit = 300) =>
    fetchApi<any[]>(`/api/candles/${symbol}?timeframe=${timeframe}&limit=${limit}`),
  getTrader: (pubkey: string) => fetchApi<any>(`/api/trader/${pubkey}`),
  getTraderOrders: (pubkey: string) => fetchApi<any>(`/api/trader/${pubkey}/orders`),
  getTraderTrades: (pubkey: string) => fetchApi<any>(`/api/trader/${pubkey}/trades`),
  getTraderFunding: (pubkey: string) => fetchApi<any>(`/api/trader/${pubkey}/funding`),
  buildMarketOrder: (params: any) =>
    fetchApi<any>("/api/tx/market-order", { method: "POST", body: JSON.stringify(params) }),
  buildLimitOrder: (params: any) =>
    fetchApi<any>("/api/tx/limit-order", { method: "POST", body: JSON.stringify(params) }),
  buildCancelOrders: (params: any) =>
    fetchApi<any>("/api/tx/cancel-orders", { method: "POST", body: JSON.stringify(params) }),
  buildDeposit: (params: any) =>
    fetchApi<any>("/api/tx/deposit", { method: "POST", body: JSON.stringify(params) }),
  buildWithdraw: (params: any) =>
    fetchApi<any>("/api/tx/withdraw", { method: "POST", body: JSON.stringify(params) }),
};
