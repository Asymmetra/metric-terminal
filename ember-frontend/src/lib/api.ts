import { API_BASE_URL } from "./constants";

const RETRY_STATUS_CODES = [502, 503];
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

async function fetchApi<T>(path: string, options?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  let lastError: Error & { status?: number } = new Error("fetch failed");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });

    if (res.ok) return res.json();

    const error = await res.json().catch(() => ({ error: res.statusText }));
    lastError = new Error(error.error || res.statusText) as Error & { status: number };
    (lastError as any).status = res.status;

    if (!RETRY_STATUS_CODES.includes(res.status) || attempt === MAX_ATTEMPTS - 1) {
      throw lastError;
    }

    await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
  }

  throw lastError;
}

export const api = {
  getMarkets: () => fetchApi<any[]>("/api/markets"),
  getMarket: (symbol: string, signal?: AbortSignal) => fetchApi<any>(`/api/markets/${symbol}`, { signal }),
  getOrderbook: (symbol: string, signal?: AbortSignal) => fetchApi<any>(`/api/orderbook/${symbol}`, { signal }),
  getCandles: (symbol: string, timeframe = "1m", limit = 300, signal?: AbortSignal) =>
    fetchApi<any[]>(`/api/candles/${symbol}?timeframe=${timeframe}&limit=${limit}`, { signal }),
  getTrader: (pubkey: string) => fetchApi<any>(`/api/trader/${pubkey}`),
  getTraderOrders: (pubkey: string, opts?: { cursor?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", opts.limit.toString());
    const qs = params.toString();
    return fetchApi<any>(`/api/trader/${pubkey}/orders${qs ? `?${qs}` : ""}`);
  },
  getTraderTrades: (pubkey: string, opts?: { cursor?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", opts.limit.toString());
    const qs = params.toString();
    return fetchApi<any>(`/api/trader/${pubkey}/trades${qs ? `?${qs}` : ""}`);
  },
  getTraderFunding: (pubkey: string, opts?: { cursor?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", opts.limit.toString());
    const qs = params.toString();
    return fetchApi<any>(`/api/trader/${pubkey}/funding${qs ? `?${qs}` : ""}`);
  },
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
  buildIsolatedMarketOrder: (params: any) =>
    fetchApi<any>("/api/tx/isolated-market-order", { method: "POST", body: JSON.stringify(params) }),
  buildIsolatedLimitOrder: (params: any) =>
    fetchApi<any>("/api/tx/isolated-limit-order", { method: "POST", body: JSON.stringify(params) }),
  buildTransferCollateral: (params: any) =>
    fetchApi<any>("/api/tx/transfer-collateral", { method: "POST", body: JSON.stringify(params) }),
  buildRegisterSubaccount: (params: any) =>
    fetchApi<any>("/api/tx/register-subaccount", { method: "POST", body: JSON.stringify(params) }),
  buildCloseAllPositions: (params: { authority: string; positions: Array<{ symbol: string; side: string; size_lots: number; margin_mode: string; subaccount_index: number }> }) =>
    fetchApi<any>("/api/tx/close-all-positions", { method: "POST", body: JSON.stringify(params) }),
  buildMultiLimitOrders: (params: { authority: string; symbol: string; bids: Array<{ price: number; size_lots: number }>; asks: Array<{ price: number; size_lots: number }> }) =>
    fetchApi<any>("/api/tx/place-multi-limit-orders", { method: "POST", body: JSON.stringify(params) }),
  buildCancelStopLoss: (params: { authority: string; symbol: string; direction: string; subaccount_index?: number }) =>
    fetchApi<any>("/api/tx/cancel-stop-loss", { method: "POST", body: JSON.stringify(params) }),
  getTraderSubaccounts: (pubkey: string) => fetchApi<any>(`/api/trader/${pubkey}/subaccounts`),
  getTraderPnl: (pubkey: string, resolution = "1h", limit = 168) =>
    fetchApi<any>(`/api/trader/${pubkey}/pnl?resolution=${resolution}&limit=${limit}`),
  getTraderCollateralHistory: (pubkey: string, limit = 100) =>
    fetchApi<any>(`/api/trader/${pubkey}/collateral-history?limit=${limit}`),
  registerLeaderboard: (authority: string) =>
    fetchApi<any>("/api/leaderboard/register", {
      method: "POST",
      body: JSON.stringify({ authority }),
    }),
  getLeaderboard: (period = "1d", limit = 50) =>
    fetchApi<any>(`/api/leaderboard?period=${period}&limit=${limit}`),
};
