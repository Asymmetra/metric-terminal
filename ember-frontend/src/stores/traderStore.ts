import { create } from "zustand";
import { TraderAccount, TraderPosition, LimitOrder, MarginMode } from "@/types/trader";

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
function transformPosition(sdkPos: any, subaccountIndex: number): TraderPosition {
  const rawSize = sdkNum(sdkPos.positionSize);
  const side = rawSize >= 0 ? "Long" : "Short";

  const marginMode: MarginMode = subaccountIndex > 0
    ? "isolated"
    : (sdkPos.marginMode || sdkPos.margin_mode || "cross") as MarginMode;

  // Extract liquidation price from SDK (may be camelCase or snake_case)
  const liqRaw = sdkPos.liquidationPrice ?? sdkPos.liquidation_price;
  const liqPrice = liqRaw != null ? sdkNum(liqRaw) : null;

  return {
    symbol: sdkPos.marketSymbol || sdkPos.symbol || "",
    side,
    size: Math.abs(rawSize),
    entry_price: sdkNum(sdkPos.entryPrice),
    mark_price: 0,
    unrealized_pnl: sdkNum(sdkPos.unrealizedPnl),
    discounted_unrealized_pnl: sdkNum(sdkPos.discountedUnrealizedPnl),
    margin_mode: marginMode,
    allocated_collateral: sdkNum(sdkPos.allocatedCollateral || sdkPos.allocated_collateral),
    liquidation_price: liqPrice && liqPrice > 0 ? liqPrice : null,
    position_value: sdkNum(sdkPos.positionValue),
    initial_margin: sdkNum(sdkPos.initialMargin || sdkPos.positionInitialMargin),
    tp_price: sdkPos.tpPrice != null ? sdkNum(sdkPos.tpPrice) : (sdkPos.tp_price != null ? sdkNum(sdkPos.tp_price) : null),
    sl_price: sdkPos.slPrice != null ? sdkNum(sdkPos.slPrice) : (sdkPos.sl_price != null ? sdkNum(sdkPos.sl_price) : null),
    subaccount_index: subaccountIndex,
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
  setAccounts: (accounts: TraderAccount[]) => void;
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
  setAccounts: (accounts) => {
    // Use cross-margin account (index 0) for portfolio summary
    const primary = accounts.find((a) => a.traderSubaccountIndex === 0) || accounts[0];

    // Aggregate positions from ALL accounts, threading subaccount_index
    const positions: TraderPosition[] = [];
    const limitOrders: Record<string, LimitOrder[]> = {};

    for (const account of accounts) {
      const subIdx = account.traderSubaccountIndex ?? 0;
      for (const pos of account.positions || []) {
        positions.push(transformPosition(pos, subIdx));
      }
      for (const [symbol, orders] of Object.entries(account.limitOrders || {})) {
        const transformed = (orders as any[]).map(transformLimitOrder);
        limitOrders[symbol] = [...(limitOrders[symbol] || []), ...transformed];
      }
    }

    set({
      account: primary,
      collateral: sdkNum(primary.effectiveCollateral),
      portfolioValue: sdkNum(primary.portfolioValue),
      unrealizedPnl: sdkNum(primary.unrealizedPnl),
      initialMargin: sdkNum(primary.initialMargin),
      maintenanceMargin: sdkNum(primary.maintenanceMargin),
      riskState: primary.riskState || "",
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
