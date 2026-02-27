import { create } from "zustand";
import { TraderAccount, TraderPosition, LimitOrder } from "@/types/trader";

// Helper to extract number from SDK's { decimals, ui, value } format
function sdkNum(val: any): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val) || 0;
  if (typeof val === "object" && val.ui != null) return parseFloat(val.ui) || 0;
  return 0;
}

// Transform SDK position (camelCase + Decimal objects) → display-ready TraderPosition
// NOTE: mark_price is NOT set here — it's computed reactively in Positions component
// from statsStore to avoid stale data between account refreshes
function transformPosition(sdkPos: any): TraderPosition {
  const rawSize = sdkNum(sdkPos.positionSize);
  const side = rawSize >= 0 ? "Long" : "Short";

  return {
    symbol: sdkPos.marketSymbol || sdkPos.symbol || "",
    side,
    size: Math.abs(rawSize),
    entry_price: sdkNum(sdkPos.entryPrice),
    mark_price: 0,
    unrealized_pnl: sdkNum(sdkPos.unrealizedPnl),
    discounted_unrealized_pnl: sdkNum(sdkPos.discountedUnrealizedPnl),
  };
}

// Transform SDK limit order (camelCase + Decimal/string) → display-ready LimitOrder
function transformLimitOrder(sdkOrder: any): LimitOrder {
  return {
    price_in_ticks: typeof sdkOrder.priceTicks === "string"
      ? parseInt(sdkOrder.priceTicks, 10) || 0
      : sdkOrder.priceTicks ?? sdkOrder.price_in_ticks ?? 0,
    order_sequence_number: typeof sdkOrder.orderSequenceNumber === "string"
      ? parseInt(sdkOrder.orderSequenceNumber, 10) || 0
      : sdkOrder.orderSequenceNumber ?? sdkOrder.order_sequence_number ?? 0,
    side: sdkOrder.side || "Bid",
    price: sdkNum(sdkOrder.price || sdkOrder.limitPrice),
    size: sdkNum(sdkOrder.initialTradeSize || sdkOrder.size),
    remaining_size: sdkNum(sdkOrder.tradeSizeRemaining || sdkOrder.remaining_size),
  };
}

interface TraderStore {
  connected: boolean;
  authority: string | null;
  account: TraderAccount | null;
  collateral: number;
  portfolioValue: number;
  unrealizedPnl: number;
  initialMargin: number;
  maintenanceMargin: number;
  riskState: string;
  positions: TraderPosition[];
  limitOrders: Record<string, LimitOrder[]>;
  setAccount: (account: TraderAccount) => void;
  setConnected: (connected: boolean, authority?: string) => void;
  reset: () => void;
}

export const useTraderStore = create<TraderStore>((set) => ({
  connected: false,
  authority: null,
  account: null,
  collateral: 0,
  portfolioValue: 0,
  unrealizedPnl: 0,
  initialMargin: 0,
  maintenanceMargin: 0,
  riskState: "",
  positions: [],
  limitOrders: {},
  setAccount: (account) => {
    // Transform SDK positions (camelCase + Decimals) → display-ready format
    const positions = (account.positions || []).map(transformPosition);

    // Transform SDK limit orders per market
    const rawOrders = account.limitOrders || {};
    const limitOrders: Record<string, LimitOrder[]> = {};
    for (const [symbol, orders] of Object.entries(rawOrders)) {
      limitOrders[symbol] = (orders as any[]).map(transformLimitOrder);
    }

    set({
      account,
      collateral: sdkNum(account.effectiveCollateral),
      portfolioValue: sdkNum(account.portfolioValue),
      unrealizedPnl: sdkNum(account.unrealizedPnl),
      initialMargin: sdkNum(account.initialMargin),
      maintenanceMargin: sdkNum(account.maintenanceMargin),
      riskState: account.riskState || "",
      positions,
      limitOrders,
    });
  },
  setConnected: (connected, authority) =>
    set({ connected, authority: authority || null }),
  reset: () =>
    set({
      connected: false,
      authority: null,
      account: null,
      collateral: 0,
      portfolioValue: 0,
      unrealizedPnl: 0,
      initialMargin: 0,
      maintenanceMargin: 0,
      riskState: "",
      positions: [],
      limitOrders: {},
    }),
}));
