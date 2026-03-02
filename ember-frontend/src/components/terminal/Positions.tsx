"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTraderStore } from "@/stores/traderStore";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { useTransactionBuilder } from "@/hooks/useTransactionBuilder";
import { wsClient } from "@/lib/ws";
import { api } from "@/lib/api";
import { formatPrice, formatUsd, formatSize } from "@/lib/format";
import { useTradeDetailStore } from "@/stores/tradeDetailStore";
import { LimitOrder, TradeHistoryItem, TraderPosition } from "@/types/trader";
import clsx from "clsx";

function ColHeader({ label, tooltip, tooltipTitle, align = "right" }: { label: string; tooltip: string; tooltipTitle?: string; align?: "left" | "right" | "center" }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  return (
    <th className={clsx("px-3 py-1.5 font-normal uppercase tracking-wider", `text-${align}`)}>
      <span
        className="cursor-help border-b border-dotted border-text-secondary/30"
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPos({ x: rect.left + rect.width / 2, y: rect.top });
          setShow(true);
        }}
        onMouseLeave={() => setShow(false)}
      >
        {label}
      </span>
      {show && (
        <div
          className="fixed z-[200] w-56 rounded border border-ember-border bg-[#1A1B20] px-3 py-2.5 text-left text-[10px] normal-case tracking-normal text-text-secondary/90 leading-relaxed shadow-[0_8px_32px_rgba(0,0,0,0.6)] pointer-events-none"
          style={{ left: Math.min(pos.x - 112, window.innerWidth - 240), top: pos.y - 8, transform: "translateY(-100%)" }}
        >
          {tooltipTitle && (
            <div className="mb-1 font-medium text-text-primary">{tooltipTitle}</div>
          )}
          <div>{tooltip}</div>
        </div>
      )}
    </th>
  );
}

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
  const [collateralPos, setCollateralPos] = useState<TraderPosition | null>(null);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryItem[]>([]);
  const [loadingTrades, setLoadingTrades] = useState(false);

  const rawPositions = useTraderStore((s) => s.positions);
  const limitOrders = useTraderStore((s) => s.limitOrders);
  const lastRefresh = useTraderStore((s) => s.lastRefresh);
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const markPrices = useStatsStore((s) => s.markPrices);
  const setMarkPrice = useStatsStore((s) => s.setMarkPrice);
  const { submitOrder, submitIsolatedOrder, cancelOrders, transferCollateral, closeAllPositions, connected } = useTransactionBuilder();
  const { publicKey } = useWallet();
  const openPosition = useTradeDetailStore((s) => s.openPosition);
  const openTradeHistoryDetail = useTradeDetailStore((s) => s.openTradeHistory);

  // Subscribe to stats WS for all markets with open positions (not just selected)
  const positionSymbols = useMemo(
    () => [...new Set(rawPositions.map((p) => p.symbol))],
    [rawPositions]
  );

  useEffect(() => {
    // Subscribe to stats for non-selected markets that have positions
    const unsubs = positionSymbols
      .filter((sym) => sym !== selectedSymbol)
      .map((sym) =>
        wsClient.subscribe("stats", sym, (data) => {
          if (data?.mark_price != null) {
            setMarkPrice(sym, data.mark_price);
          }
        })
      );

    return () => { unsubs.forEach((unsub) => unsub()); };
  }, [positionSymbols, selectedSymbol, setMarkPrice]);

  // Inject live mark_price and recompute unrealized PnL from current prices.
  // The REST snapshot PnL freezes at fetch time — this keeps it live.
  const positions = useMemo(() =>
    rawPositions.map((pos) => {
      const liveMarkPrice = markPrices[pos.symbol] ?? pos.mark_price;
      const isLong = pos.side.toLowerCase() === "long";
      // Recompute PnL: (mark - entry) * size for longs, (entry - mark) * size for shorts
      const livePnl = liveMarkPrice > 0 && pos.entry_price > 0
        ? isLong
          ? (liveMarkPrice - pos.entry_price) * pos.size
          : (pos.entry_price - liveMarkPrice) * pos.size
        : pos.unrealized_pnl;
      // Recompute notional from live mark price
      const liveNotional = liveMarkPrice > 0 ? pos.size * liveMarkPrice : pos.position_value;
      return {
        ...pos,
        mark_price: liveMarkPrice,
        unrealized_pnl: livePnl,
        position_value: liveNotional,
      };
    }),
    [rawPositions, markPrices]
  );

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

  // Refresh trade history when tab is active, wallet connects, or trader data updates (post-tx)
  useEffect(() => {
    if (activeTab === "trades" && publicKey) {
      fetchTradeHistory();
    }
  }, [activeTab, publicKey, fetchTradeHistory, lastRefresh]);

  // Cancel now requires price_in_ticks + order_sequence_number
  const handleCancel = async (order: LimitOrder & { symbol: string }) => {
    const key = `${order.price_in_ticks}:${order.order_sequence_number}`;
    setCancellingKey(key);
    try {
      await cancelOrders(order.symbol, [
        { price_in_ticks: order.price_in_ticks, order_sequence_number: order.order_sequence_number },
      ]);
    } catch (e: any) {
      console.error("Cancel failed:", e);
    } finally {
      setCancellingKey(null);
    }
  };

  // Close a single position via market order on opposite side
  const handleClose = async (pos: typeof positions[0]) => {
    if (closingSymbol) return; // prevent concurrent close operations
    setClosingSymbol(pos.symbol);
    try {
      const market = await api.getMarket(pos.symbol);
      const lotSize = 10 ** -(market.baseLotsDecimals || 2);
      const sizeLots = Math.round(pos.size / lotSize);
      const closeSide = pos.side.toLowerCase() === "long" ? "ask" : "bid";
      const closeParams = { symbol: pos.symbol, side: closeSide, size_lots: sizeLots };
      if (pos.margin_mode === "isolated") {
        await submitIsolatedOrder("market", closeParams);
      } else {
        await submitOrder("market", closeParams);
      }
    } catch (e: any) {
      console.error("Close position failed:", e);
    } finally {
      setClosingSymbol(null);
    }
  };

  // Close all positions in a single batched transaction
  const handleCloseAll = async () => {
    if (closingAll || positions.length === 0) return;
    setClosingAll(true);
    try {
      // Fetch market data for all positions to calculate lot sizes
      const positionData = await Promise.all(
        positions.map(async (pos) => {
          const market = await api.getMarket(pos.symbol);
          const lotSize = 10 ** -(market.baseLotsDecimals || 2);
          const sizeLots = Math.round(pos.size / lotSize);
          return {
            symbol: pos.symbol,
            side: pos.side.toLowerCase(),
            size_lots: sizeLots,
            margin_mode: pos.margin_mode,
            subaccount_index: pos.subaccount_index ?? (pos.margin_mode === "isolated" ? 1 : 0),
          };
        })
      );

      await closeAllPositions(positionData);
    } catch (e: any) {
      console.error("Close all failed:", e);
    } finally {
      setClosingAll(false);
    }
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
              <div className="scrollbar-hide overflow-x-auto">
              <table className="w-full min-w-[1000px]">
                <thead>
                  <tr className="text-[10px] text-text-secondary/70">
                    <ColHeader label="Symbol" tooltipTitle="Symbol" tooltip="Perpetual contract market symbol" align="left" />
                    <ColHeader label="Side" tooltipTitle="Side" tooltip="Position direction: Long (profit when price rises) or Short (profit when price falls)" align="left" />
                    <ColHeader label="Size" tooltipTitle="Size" tooltip="Position size in base asset units" />
                    <ColHeader label="Entry" tooltipTitle="Entry Price" tooltip="Average entry price of the position" />
                    <ColHeader label="Mark" tooltipTitle="Mark Price" tooltip="Current mark price used for PnL and margin calculations. Updated in real-time from the oracle." />
                    <ColHeader label="Collateral" tooltipTitle="Collateral" tooltip="Capital backing this position. For isolated: allocated collateral. For cross: initial margin requirement. Formula: Notional ÷ Leverage" />
                    <ColHeader label="Unreal. PnL" tooltipTitle="Unrealized PnL" tooltip="Unrealized profit/loss. Formula: (Mark − Entry) × Size for longs, (Entry − Mark) × Size for shorts" />
                    <ColHeader label="ROI%" tooltipTitle="Return on Investment" tooltip="Return on invested collateral. Formula: Unrealized PnL ÷ Collateral × 100" />
                    <ColHeader label="Liq. Price" tooltipTitle="Liquidation Price" tooltip="Price at which the position will be liquidated. Provided by the exchange based on your margin and maintenance requirements." />
                    <ColHeader label="Liq. Dist" tooltipTitle="Liquidation Distance" tooltip="Distance from current mark price to liquidation price as a percentage. Formula: |Mark − Liq. Price| ÷ Mark × 100. Red < 5%, Yellow < 10%, Green > 10%." />
                    <ColHeader label="Leverage" tooltipTitle="Leverage" tooltip="Effective leverage of the position. Formula: Notional Value ÷ Collateral. Higher leverage = higher risk and reward." />
                    <ColHeader label="Mode" tooltipTitle="Margin Mode" tooltip="Cross: shares collateral across positions. Isolated: dedicated collateral per position." align="center" />
                    <ColHeader label="TP" tooltipTitle="Take Profit" tooltip="Take profit price. Position auto-closes at this price to lock in gains." />
                    <ColHeader label="SL" tooltipTitle="Stop Loss" tooltip="Stop loss price. Position auto-closes at this price to limit losses." />
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
                  {positions.map((pos) => {
                    const isLong = pos.side.toLowerCase() === "long";
                    const posKey = `${pos.symbol}-${pos.subaccount_index}`;

                    // Collateral: use initial_margin (available for all positions from SDK)
                    const collateral = pos.allocated_collateral > 0
                      ? pos.allocated_collateral
                      : pos.initial_margin > 0 ? pos.initial_margin : 0;

                    // ROI%: PnL / collateral backing this position
                    const roi = collateral > 0
                      ? (pos.unrealized_pnl / collateral) * 100
                      : 0;

                    // Liquidation distance: use real liq price from SDK
                    const liqPrice = pos.liquidation_price;
                    const liqDistPct = liqPrice != null && pos.mark_price > 0
                      ? Math.abs((pos.mark_price - liqPrice) / pos.mark_price) * 100
                      : null;

                    // Effective leverage
                    const notional = pos.position_value > 0 ? pos.position_value : pos.size * pos.mark_price;
                    const effLeverage = collateral > 0 ? notional / collateral : 0;

                    return (
                      <tr
                        key={posKey}
                        onClick={() => openPosition(pos)}
                        className="cursor-pointer font-mono text-[11px] transition-colors hover:bg-surface-l2/30"
                        style={{ height: "28px" }}
                      >
                        <td className="px-3 text-text-primary">{pos.symbol}-PERP</td>
                        <td className={clsx("px-3 font-medium", isLong ? "text-ember-green" : "text-ember-red")}>
                          {pos.side.toUpperCase()}
                        </td>
                        <td className="px-3 text-right text-text-primary/90">{formatSize(pos.size, 2)}</td>
                        <td className="px-3 text-right text-text-secondary/60">${formatPrice(pos.entry_price)}</td>
                        <td className="px-3 text-right text-text-secondary/60">${formatPrice(pos.mark_price)}</td>
                        <td className="px-3 text-right text-text-secondary/60">
                          {collateral > 0
                            ? `$${formatPrice(collateral)}`
                            : "—"}
                        </td>
                        <td className={clsx("px-3 text-right font-medium", pos.unrealized_pnl >= 0 ? "text-ember-green" : "text-ember-red")}>
                          {pos.unrealized_pnl >= 0 ? "+" : ""}{formatUsd(pos.unrealized_pnl)}
                        </td>
                        <td className={clsx("px-3 text-right font-mono text-[10px]", roi >= 0 ? "text-ember-green" : "text-ember-red")}>
                          {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                        </td>
                        <td className="px-3 text-right font-mono text-[10px] text-ember-red/80">
                          {liqPrice != null ? `$${formatPrice(liqPrice)}` : "—"}
                        </td>
                        <td className={clsx(
                          "px-3 text-right font-mono text-[10px]",
                          liqDistPct == null ? "text-text-secondary/50"
                            : liqDistPct < 5 ? "text-ember-red"
                            : liqDistPct < 10 ? "text-yellow-500"
                            : "text-ember-green"
                        )}>
                          {liqDistPct != null ? `${liqDistPct.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-3 text-right font-mono text-[10px] text-ember-orange">
                          {effLeverage > 0 ? `${effLeverage.toFixed(1)}x` : "—"}
                        </td>
                        <td className="px-3 text-center">
                          <span className={clsx(
                            "inline-block px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
                            pos.margin_mode === "isolated"
                              ? "text-ember-orange bg-ember-orange/10"
                              : "text-text-secondary/60 bg-surface-l2"
                          )}>
                            {pos.margin_mode === "isolated" ? "ISO" : "CROSS"}
                          </span>
                          {pos.margin_mode === "isolated" && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setCollateralPos(pos); }}
                              className="ml-1 font-mono text-[9px] text-text-secondary/60 hover:text-ember-orange transition-colors"
                            >
                              +/−
                            </button>
                          )}
                        </td>
                        <td className="px-3 text-right font-mono text-[10px]">
                          {pos.tp_price != null
                            ? <span className="text-ember-green">${formatPrice(pos.tp_price)}</span>
                            : <span className="text-text-secondary/30">—</span>}
                        </td>
                        <td className="px-3 text-right font-mono text-[10px]">
                          {pos.sl_price != null
                            ? <span className="text-ember-red">${formatPrice(pos.sl_price)}</span>
                            : <span className="text-text-secondary/30">—</span>}
                        </td>
                        <td className="px-3 text-right">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleClose(pos); }}
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
              </div>
            ) : (
              <EmptyState message={connected ? "No open positions" : "Connect wallet to view positions"} />
            )}
          </>
        )}

        {activeTab === "orders" && (
          <>
            {allOrders.length > 0 ? (
              <div className="scrollbar-hide overflow-x-auto">
              <table className="w-full min-w-[600px]">
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
              </div>
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
              <div className="scrollbar-hide overflow-x-auto">
              <table className="w-full min-w-[700px]">
                <thead>
                  <tr className="text-[10px] text-text-secondary/70">
                    <th className="px-3 py-1.5 text-left font-normal uppercase tracking-wider">Symbol</th>
                    <th className="px-3 py-1.5 text-left font-normal uppercase tracking-wider">Type</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Price</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Size</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Notional</th>
                    <th className="px-3 py-1.5 text-right font-normal uppercase tracking-wider">Time</th>
                    <th className="px-3 py-1.5 text-center font-normal uppercase tracking-wider">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeHistory.map((trade) => {
                    const price = parseFloat(trade.price);
                    const size = parseFloat(trade.baseQty);
                    const notional = price * size;
                    const isBuy = /market.*order|place.*order/i.test(trade.instructionType)
                      ? parseFloat(trade.baseQty) > 0
                      : true;
                    const typeLabel = trade.instructionType
                      ?.replace(/([A-Z])/g, " $1")
                      .replace(/^./, (s) => s.toUpperCase())
                      .trim() || "Trade";

                    return (
                      <tr
                        key={`${trade.transactionSignature}-${trade.timestamp}`}
                        onClick={() => openTradeHistoryDetail(trade)}
                        className="cursor-pointer font-mono text-[11px] transition-colors hover:bg-surface-l2/30"
                        style={{ height: "28px" }}
                      >
                        <td className="px-3 text-text-primary">{trade.marketSymbol}-PERP</td>
                        <td className="px-3 text-text-secondary/60 text-[10px]">{typeLabel}</td>
                        <td className="px-3 text-right text-text-primary/90">${formatPrice(price)}</td>
                        <td className="px-3 text-right text-text-secondary/60">{formatSize(size, 4)}</td>
                        <td className="px-3 text-right text-text-secondary/60">${formatPrice(notional)}</td>
                        <td className="px-3 text-right text-text-secondary/60">
                          {new Date(trade.timestamp).toLocaleString("en-US", {
                            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
                          })}
                        </td>
                        <td className="px-3 text-center">
                          <a
                            href={`https://orbmarkets.io/tx/${trade.transactionSignature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-ember-orange/60 hover:text-ember-orange transition-colors"
                          >
                            <svg className="inline h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M6 3H3v10h10v-3" />
                              <path d="M9 2h5v5" />
                              <path d="M14 2L7 9" />
                            </svg>
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Collateral management modal */}
      {collateralPos && (
        <CollateralModal
          position={collateralPos}
          onClose={() => setCollateralPos(null)}
          transferCollateral={transferCollateral}
        />
      )}
    </div>
  );
}

function CollateralModal({
  position,
  onClose,
  transferCollateral,
}: {
  position: TraderPosition;
  onClose: () => void;
  transferCollateral: (from: number, to: number, amount: number) => Promise<any>;
}) {
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const collateral = useTraderStore((s) => s.collateral);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const handleSubmit = async () => {
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) {
      setError("Enter a valid amount");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // Bridge uses subaccount indices: 0 = cross, isolated positions use their actual index
      const isoIdx = position.subaccount_index;
      if (mode === "add") {
        // Transfer from cross (0) to isolated subaccount
        await transferCollateral(0, isoIdx, parsed);
      } else {
        // Transfer from isolated subaccount to cross (0)
        await transferCollateral(isoIdx, 0, parsed);
      }
      setAmount("");
      onClose();
    } catch (e: any) {
      setError(e?.message || "Transfer failed");
    } finally {
      setLoading(false);
    }
  };

  const notional = position.size * position.mark_price;
  const marginRatio = position.allocated_collateral > 0
    ? (position.allocated_collateral / notional) * 100
    : 0;

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="w-[360px] border border-ember-border bg-surface-l1 shadow-[0_16px_64px_rgba(0,0,0,0.6)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-ember-border px-4 py-3">
          <span className="font-mono text-xs font-medium uppercase tracking-wider text-text-primary">
            {position.symbol}-PERP Collateral
          </span>
          <button
            onClick={onClose}
            className="text-text-secondary/60 transition-colors hover:text-text-primary"
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-ember-border/50">
          {(["add", "remove"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); }}
              className={clsx(
                "flex-1 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors",
                mode === m
                  ? "border-b border-ember-orange text-text-primary"
                  : "text-text-secondary/60 hover:text-text-secondary"
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex flex-col gap-3 p-4">
          {/* Position info */}
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between">
              <span className="text-[10px] text-text-secondary/70 uppercase tracking-wider">Position</span>
              <span className="font-mono text-[11px] text-text-primary">
                {position.size} {position.symbol} {position.side}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[10px] text-text-secondary/70 uppercase tracking-wider">Current Collateral</span>
              <span className="font-mono text-[11px] text-text-primary">
                ${formatPrice(position.allocated_collateral)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[10px] text-text-secondary/70 uppercase tracking-wider">Margin Ratio</span>
              <span className="font-mono text-[11px] text-ember-orange">
                {marginRatio.toFixed(1)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[10px] text-text-secondary/70 uppercase tracking-wider">Cross Available</span>
              <span className="font-mono text-[11px] text-text-secondary">
                ${formatPrice(collateral)}
              </span>
            </div>
          </div>

          {/* Amount input */}
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-text-secondary/70 uppercase">
              Amount
            </label>
            <div className="relative">
              <input
                type="number"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setError(null); }}
                placeholder="0.00"
                autoFocus
                className="w-full border border-ember-border bg-surface-l2 py-2.5 pl-3 pr-16 font-mono text-sm text-text-primary placeholder:text-text-secondary/40 focus:border-ember-orange/60 focus:outline-none transition-colors"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-secondary/60">
                USDC
              </span>
            </div>
          </div>

          {/* Quick amounts */}
          <div className="flex gap-2">
            {[10, 50, 100, 500].map((val) => (
              <button
                key={val}
                onClick={() => setAmount(val.toString())}
                className="flex-1 border border-ember-border/50 py-1 font-mono text-[10px] text-text-secondary/60 transition-colors hover:border-ember-orange/30 hover:text-text-secondary"
              >
                ${val}
              </button>
            ))}
          </div>

          {error && (
            <div className="font-mono text-[10px] text-ember-red">{error}</div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!amount || loading}
            className={clsx(
              "w-full py-2.5 font-mono text-[11px] font-medium uppercase tracking-wider transition-all duration-150",
              mode === "add"
                ? "bg-ember-orange text-white hover:brightness-110 active:brightness-95"
                : "bg-surface-l2 border border-ember-orange text-ember-orange hover:bg-ember-orange/10",
              loading && "opacity-50 pointer-events-none"
            )}
          >
            {loading ? "Processing..." : mode === "add" ? "Add Collateral" : "Remove Collateral"}
          </button>
        </div>
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
