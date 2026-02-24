"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTraderStore } from "@/stores/traderStore";
import { useMarketStore } from "@/stores/marketStore";
import { useTransactionBuilder } from "@/hooks/useTransactionBuilder";
import { useToastStore } from "@/stores/toastStore";
import { api } from "@/lib/api";
import { formatPrice, formatUsd, formatSize } from "@/lib/format";
import { LimitOrder, TradeHistoryItem } from "@/types/trader";
import clsx from "clsx";

type Tab = "positions" | "orders" | "trades";

const TABS: { key: Tab; label: string }[] = [
  { key: "positions", label: "Positions" },
  { key: "orders", label: "Open Orders" },
  { key: "trades", label: "Trade History" },
];

export function Positions() {
  const [activeTab, setActiveTab] = useState<Tab>("positions");
  const [cancellingKey, setCancellingKey] = useState<string | null>(null);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryItem[]>([]);
  const [loadingTrades, setLoadingTrades] = useState(false);

  const positions = useTraderStore((s) => s.positions);
  const limitOrders = useTraderStore((s) => s.limitOrders);
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const { submitOrder, cancelOrders, connected } = useTransactionBuilder();
  const addToast = useToastStore((s) => s.addToast);
  const { publicKey } = useWallet();

  // Flatten limitOrders map into a displayable list with symbol attached
  const allOrders = useMemo(() => {
    const result: (LimitOrder & { symbol: string })[] = [];
    for (const [symbol, orders] of Object.entries(limitOrders)) {
      for (const order of orders) {
        result.push({ ...order, symbol });
      }
    }
    return result;
  }, [limitOrders]);

  // Fetch trade history when wallet connects or tab switches
  const fetchTradeHistory = useCallback(async () => {
    if (!publicKey) return;
    setLoadingTrades(true);
    try {
      const result = await api.getTraderTrades(publicKey.toBase58());
      setTradeHistory(result.trades || []);
    } catch {
      setTradeHistory([]);
    } finally {
      setLoadingTrades(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (activeTab === "trades" && publicKey) {
      fetchTradeHistory();
    }
  }, [activeTab, publicKey, fetchTradeHistory]);

  // Cancel now requires price_in_ticks + order_sequence_number
  const handleCancel = async (order: LimitOrder & { symbol: string }) => {
    const key = `${order.price_in_ticks}:${order.order_sequence_number}`;
    setCancellingKey(key);
    try {
      await cancelOrders(order.symbol, [
        { price_in_ticks: order.price_in_ticks, order_sequence_number: order.order_sequence_number },
      ]);
      addToast("success", `Order cancelled on ${order.symbol}`);
    } catch (e: any) {
      console.error("Cancel failed:", e);
      addToast("error", e?.message || "Cancel failed");
    } finally {
      setCancellingKey(null);
    }
  };

  // Close a single position via market order on opposite side
  const handleClose = async (pos: typeof positions[0]) => {
    setClosingSymbol(pos.symbol);
    try {
      const market = await api.getMarket(pos.symbol);
      const lotSize = 10 ** -(market.baseLotsDecimals || 2);
      const sizeLots = Math.round(pos.size / lotSize);
      const closeSide = pos.side.toLowerCase() === "long" ? "ask" : "bid";
      await submitOrder("market", {
        symbol: pos.symbol,
        side: closeSide,
        size_lots: sizeLots,
      });
      addToast("success", `Closed ${pos.symbol} ${pos.side} position`);
    } catch (e: any) {
      addToast("error", e?.message || "Close position failed");
    } finally {
      setClosingSymbol(null);
    }
  };

  // Close all positions sequentially
  const handleCloseAll = async () => {
    setClosingAll(true);
    for (const pos of positions) {
      try {
        const market = await api.getMarket(pos.symbol);
        const lotSize = 10 ** -(market.baseLotsDecimals || 2);
        const sizeLots = Math.round(pos.size / lotSize);
        const closeSide = pos.side.toLowerCase() === "long" ? "ask" : "bid";
        await submitOrder("market", {
          symbol: pos.symbol,
          side: closeSide,
          size_lots: sizeLots,
        });
        addToast("success", `Closed ${pos.symbol} ${pos.side}`);
      } catch (e: any) {
        addToast("error", `Failed to close ${pos.symbol}: ${e?.message || "Unknown error"}`);
      }
    }
    setClosingAll(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center border-b border-ember-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              "relative px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
              activeTab === tab.key
                ? "text-text-primary"
                : "text-text-secondary/60 hover:text-text-secondary"
            )}
          >
            {tab.label}
            {activeTab === tab.key && (
              <div className="absolute bottom-0 left-0 right-0 h-px bg-ember-orange" />
            )}
          </button>
        ))}

        {/* Counts */}
        <div className="ml-auto flex items-center gap-3 pr-3">
          {positions.length > 0 && (
            <span className="font-mono text-[10px] text-text-secondary/50">
              {positions.length} position{positions.length !== 1 ? "s" : ""}
            </span>
          )}
          {allOrders.length > 0 && (
            <span className="font-mono text-[10px] text-text-secondary/50">
              {allOrders.length} order{allOrders.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "positions" && (
          <>
            {positions.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-text-secondary/70">
                    <th className="px-3 py-1.5 text-left font-normal uppercase tracking-wider">Symbol</th>
                    <th className="px-3 py-1.5 text-left font-normal uppercase tracking-wider">Side</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Size</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Entry</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Mark</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Unreal. PnL</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">
                      <button
                        onClick={handleCloseAll}
                        disabled={closingAll}
                        className={clsx(
                          "font-mono text-[10px] uppercase tracking-wider transition-colors",
                          closingAll ? "text-text-secondary/50" : "text-ember-red/70 hover:text-ember-red"
                        )}
                      >
                        {closingAll ? "Closing..." : "Close All"}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos, i) => {
                    const isLong = pos.side.toLowerCase() === "long";
                    return (
                      <tr
                        key={i}
                        className="font-mono text-[11px] transition-colors hover:bg-surface-l2/30"
                        style={{ height: "28px" }}
                      >
                        <td className="px-3 text-text-primary">{pos.symbol}-PERP</td>
                        <td className={clsx("px-3 font-medium", isLong ? "text-ember-green" : "text-ember-red")}>
                          {pos.side.toUpperCase()}
                        </td>
                        <td className="px-3 text-right text-text-primary/90">{formatSize(pos.size, 2)}</td>
                        <td className="px-3 text-right text-text-secondary/60">${formatPrice(pos.entry_price)}</td>
                        <td className="px-3 text-right text-text-secondary/60">${formatPrice(pos.mark_price)}</td>
                        <td className={clsx("px-3 text-right font-medium", pos.unrealized_pnl >= 0 ? "text-ember-green" : "text-ember-red")}>
                          {pos.unrealized_pnl >= 0 ? "+" : ""}{formatUsd(pos.unrealized_pnl)}
                        </td>
                        <td className="px-3 text-right">
                          <button
                            onClick={() => handleClose(pos)}
                            disabled={closingSymbol === pos.symbol || closingAll}
                            className={clsx(
                              "font-mono text-[10px] uppercase tracking-wider transition-colors",
                              closingSymbol === pos.symbol || closingAll
                                ? "text-text-secondary/50"
                                : "text-ember-red/70 hover:text-ember-red"
                            )}
                          >
                            {closingSymbol === pos.symbol ? "..." : "Close"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState message={connected ? "No open positions" : "Connect wallet to view positions"} />
            )}
          </>
        )}

        {activeTab === "orders" && (
          <>
            {allOrders.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-text-secondary/70">
                    <th className="px-3 py-1.5 text-left font-normal uppercase tracking-wider">Symbol</th>
                    <th className="px-3 py-1.5 text-left font-normal uppercase tracking-wider">Side</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Price</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Size</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Remaining</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {allOrders.map((order) => {
                    const key = `${order.price_in_ticks}:${order.order_sequence_number}`;
                    const isBid = order.side.toLowerCase() === "bid";
                    return (
                      <tr
                        key={key}
                        className="font-mono text-[11px] transition-colors hover:bg-surface-l2/30"
                        style={{ height: "28px" }}
                      >
                        <td className="px-3 text-text-primary">{order.symbol}-PERP</td>
                        <td className={clsx("px-3 font-medium", isBid ? "text-ember-green" : "text-ember-red")}>
                          {isBid ? "BUY" : "SELL"}
                        </td>
                        <td className="px-3 text-right text-text-primary/90">${formatPrice(order.price)}</td>
                        <td className="px-3 text-right text-text-secondary/60">{formatSize(order.size, 2)}</td>
                        <td className="px-3 text-right text-text-secondary/60">{formatSize(order.remaining_size, 2)}</td>
                        <td className="px-3 text-right">
                          <button
                            onClick={() => handleCancel(order)}
                            disabled={cancellingKey === key}
                            className={clsx(
                              "font-mono text-[10px] uppercase tracking-wider transition-colors",
                              cancellingKey === key
                                ? "text-text-secondary/50"
                                : "text-ember-red/70 hover:text-ember-red"
                            )}
                          >
                            {cancellingKey === key ? "..." : "Cancel"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState message={connected ? "No open orders" : "Connect wallet to view orders"} />
            )}
          </>
        )}

        {activeTab === "trades" && (
          <>
            {!connected ? (
              <EmptyState message="Connect wallet to view trade history" />
            ) : loadingTrades ? (
              <EmptyState message="Loading trades..." />
            ) : tradeHistory.length === 0 ? (
              <EmptyState message="No trade history" />
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-text-secondary/70">
                    <th className="px-3 py-1.5 text-left font-normal uppercase tracking-wider">Symbol</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Price</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Size</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeHistory.map((trade, i) => (
                    <tr
                      key={i}
                      className="font-mono text-[11px] transition-colors hover:bg-surface-l2/30"
                      style={{ height: "28px" }}
                    >
                      <td className="px-3 text-text-primary">{trade.marketSymbol}-PERP</td>
                      <td className="px-3 text-right text-text-primary/90">${formatPrice(parseFloat(trade.price))}</td>
                      <td className="px-3 text-right text-text-secondary/60">{formatSize(parseFloat(trade.baseQty), 2)}</td>
                      <td className="px-3 text-right text-text-secondary/60">
                        {new Date(trade.timestamp).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-10">
      <span className="font-mono text-[11px] text-text-secondary/50">{message}</span>
    </div>
  );
}
