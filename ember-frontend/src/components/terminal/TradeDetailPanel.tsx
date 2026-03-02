"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTradeDetailStore } from "@/stores/tradeDetailStore";
import { useStatsStore } from "@/stores/statsStore";
import { formatPrice, formatSize, formatUsd } from "@/lib/format";
import clsx from "clsx";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[10px] uppercase tracking-wider text-text-secondary/70">{label}</span>
      <span className="font-mono text-[11px] text-text-primary">{children}</span>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="pt-3 pb-1 mt-2 border-t border-ember-border/30">
      <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/40">{title}</span>
    </div>
  );
}

export function TradeDetailPanel() {
  const open = useTradeDetailStore((s) => s.open);
  const detail = useTradeDetailStore((s) => s.detail);
  const close = useTradeDetailStore((s) => s.close);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  return (
    <AnimatePresence>
      {open && detail && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
            className="fixed inset-0 z-[90] bg-black/40"
          />

          {/* Panel */}
          <motion.div
            initial={{ x: 380 }}
            animate={{ x: 0 }}
            exit={{ x: 380 }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 z-[90] w-[380px] border-l border-ember-border bg-surface-l1 shadow-[−16px_0_64px_rgba(0,0,0,0.4)] overflow-y-auto"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-ember-border px-4 py-3">
              <span className="font-mono text-xs font-medium uppercase tracking-wider text-text-primary">
                {detail.type === "position" && `${detail.data.symbol}-PERP Position`}
                {detail.type === "tradeHistory" && `${detail.data.marketSymbol}-PERP Trade`}
                {detail.type === "recentTrade" && "Recent Trade"}
              </span>
              <button
                onClick={close}
                className="text-text-secondary/60 transition-colors hover:text-text-primary"
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex flex-col gap-px p-4">
              {detail.type === "position" && <PositionDetail data={detail.data} />}
              {detail.type === "tradeHistory" && <TradeHistoryDetail data={detail.data} />}
              {detail.type === "recentTrade" && <RecentTradeDetail data={detail.data} />}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function PositionDetail({ data }: { data: import("@/types/trader").TraderPosition }) {
  const isLong = data.side.toLowerCase() === "long";
  const markPrices = useStatsStore((s) => s.markPrices);
  const liveMarkPrice = markPrices[data.symbol] ?? data.mark_price;

  // Derived values
  const collateral = data.allocated_collateral > 0
    ? data.allocated_collateral
    : data.initial_margin > 0 ? data.initial_margin : 0;
  const notional = data.position_value > 0 ? data.position_value : data.size * liveMarkPrice;
  const effLeverage = collateral > 0 ? notional / collateral : 0;
  const roi = collateral > 0 ? (data.unrealized_pnl / collateral) * 100 : 0;
  const liqDistPct = data.liquidation_price != null && liveMarkPrice > 0
    ? Math.abs((liveMarkPrice - data.liquidation_price) / liveMarkPrice) * 100
    : null;
  const pnlPct = data.entry_price > 0
    ? ((liveMarkPrice - data.entry_price) / data.entry_price) * 100 * (isLong ? 1 : -1)
    : 0;

  return (
    <>
      {/* Core position info */}
      <DetailRow label="Symbol">{data.symbol}-PERP</DetailRow>
      <DetailRow label="Side">
        <span className={isLong ? "text-ember-green" : "text-ember-red"}>
          {data.side.toUpperCase()}
        </span>
      </DetailRow>
      <DetailRow label="Size">{formatSize(data.size, 4)} {data.symbol}</DetailRow>
      <DetailRow label="Notional Value">${formatPrice(notional)}</DetailRow>
      <DetailRow label="Margin Mode">
        <span className={clsx(
          "inline-block px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
          data.margin_mode === "isolated"
            ? "text-ember-orange bg-ember-orange/10"
            : "text-text-secondary/60 bg-surface-l2"
        )}>
          {data.margin_mode === "isolated" ? "ISOLATED" : "CROSS"}
        </span>
      </DetailRow>
      <DetailRow label="Subaccount">
        {data.subaccount_index === 0 ? "Cross (0)" : `Isolated #${data.subaccount_index}`}
      </DetailRow>

      {/* Pricing */}
      <SectionHeader title="Pricing" />
      <DetailRow label="Entry Price">${formatPrice(data.entry_price)}</DetailRow>
      <DetailRow label="Mark Price">${formatPrice(liveMarkPrice)}</DetailRow>
      <DetailRow label="Price Change">
        <span className={pnlPct >= 0 ? "text-ember-green" : "text-ember-red"}>
          {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
        </span>
      </DetailRow>

      {/* PnL & Returns */}
      <SectionHeader title="PnL & Returns" />
      <DetailRow label="Unrealized PnL">
        <span className={data.unrealized_pnl >= 0 ? "text-ember-green" : "text-ember-red"}>
          {data.unrealized_pnl >= 0 ? "+" : ""}{formatUsd(data.unrealized_pnl)}
        </span>
      </DetailRow>
      <DetailRow label="Discounted PnL">
        <span className={data.discounted_unrealized_pnl >= 0 ? "text-ember-green" : "text-ember-red"}>
          {data.discounted_unrealized_pnl >= 0 ? "+" : ""}{formatUsd(data.discounted_unrealized_pnl)}
        </span>
      </DetailRow>
      <DetailRow label="ROI">
        <span className={roi >= 0 ? "text-ember-green" : "text-ember-red"}>
          {roi >= 0 ? "+" : ""}{roi.toFixed(2)}%
        </span>
      </DetailRow>

      {/* Margin & Risk */}
      <SectionHeader title="Margin & Risk" />
      <DetailRow label="Collateral">${formatPrice(collateral)}</DetailRow>
      {data.allocated_collateral > 0 && data.allocated_collateral !== collateral && (
        <DetailRow label="Allocated Collateral">${formatPrice(data.allocated_collateral)}</DetailRow>
      )}
      <DetailRow label="Initial Margin">${formatPrice(data.initial_margin)}</DetailRow>
      <DetailRow label="Eff. Leverage">
        <span className="text-ember-orange">
          {effLeverage > 0 ? `${effLeverage.toFixed(2)}x` : "—"}
        </span>
      </DetailRow>
      <DetailRow label="Liquidation Price">
        {data.liquidation_price != null
          ? <span className="text-ember-red">${formatPrice(data.liquidation_price)}</span>
          : <span className="text-text-secondary/30">—</span>}
      </DetailRow>
      <DetailRow label="Liq. Distance">
        {liqDistPct != null
          ? <span className={liqDistPct < 5 ? "text-ember-red" : liqDistPct < 10 ? "text-yellow-500" : "text-ember-green"}>
              {liqDistPct.toFixed(2)}%
            </span>
          : <span className="text-text-secondary/30">—</span>}
      </DetailRow>

      {/* TP/SL */}
      <SectionHeader title="Take Profit / Stop Loss" />
      <DetailRow label="Take Profit">
        {data.tp_price != null
          ? <span className="text-ember-green">${formatPrice(data.tp_price)}</span>
          : <span className="text-text-secondary/30">Not set</span>}
      </DetailRow>
      <DetailRow label="Stop Loss">
        {data.sl_price != null
          ? <span className="text-ember-red">${formatPrice(data.sl_price)}</span>
          : <span className="text-text-secondary/30">Not set</span>}
      </DetailRow>
      {data.tp_price != null && (
        <DetailRow label="TP Distance">
          <span className="text-ember-green">
            {liveMarkPrice > 0 ? `${(Math.abs((data.tp_price - liveMarkPrice) / liveMarkPrice) * 100).toFixed(2)}%` : "—"}
          </span>
        </DetailRow>
      )}
      {data.sl_price != null && (
        <DetailRow label="SL Distance">
          <span className="text-ember-red">
            {liveMarkPrice > 0 ? `${(Math.abs((data.sl_price - liveMarkPrice) / liveMarkPrice) * 100).toFixed(2)}%` : "—"}
          </span>
        </DetailRow>
      )}
      {data.tp_price != null && data.sl_price != null && (
        <DetailRow label="Risk/Reward">
          {(() => {
            const risk = Math.abs(liveMarkPrice - data.sl_price);
            const reward = Math.abs(data.tp_price - liveMarkPrice);
            const rr = risk > 0 ? reward / risk : 0;
            return <span className="text-text-primary">1:{rr.toFixed(2)}</span>;
          })()}
        </DetailRow>
      )}
    </>
  );
}

function TradeHistoryDetail({ data }: { data: import("@/types/trader").TradeHistoryItem }) {
  const price = parseFloat(data.price);
  const baseQty = parseFloat(data.baseQty);
  const quoteQty = parseFloat(data.quoteQty);
  const notional = price * baseQty;
  const typeLabel = data.instructionType
    ?.replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim() || "Trade";

  return (
    <>
      <DetailRow label="Symbol">{data.marketSymbol}-PERP</DetailRow>
      <DetailRow label="Type">{typeLabel}</DetailRow>

      <SectionHeader title="Execution" />
      <DetailRow label="Price">${formatPrice(price)}</DetailRow>
      <DetailRow label="Base Quantity">{formatSize(baseQty, 4)} {data.marketSymbol}</DetailRow>
      <DetailRow label="Quote Quantity">${formatPrice(quoteQty)}</DetailRow>
      <DetailRow label="Notional Value">${formatPrice(notional)}</DetailRow>

      <SectionHeader title="Timing" />
      <DetailRow label="Executed At">
        {new Date(data.timestamp).toLocaleString("en-US", {
          year: "numeric", month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        })}
      </DetailRow>

      <SectionHeader title="On-Chain" />
      <DetailRow label="Transaction">
        <a
          href={`https://orbmarkets.io/tx/${data.transactionSignature}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-ember-orange hover:underline"
        >
          {data.transactionSignature.slice(0, 8)}...{data.transactionSignature.slice(-6)}
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 3H3v10h10v-3" />
            <path d="M9 2h5v5" />
            <path d="M14 2L7 9" />
          </svg>
        </a>
      </DetailRow>
    </>
  );
}

function RecentTradeDetail({ data }: { data: import("@/types/market").Trade }) {
  const ts = typeof data.timestamp === "string"
    ? new Date(data.timestamp)
    : new Date(data.timestamp * 1000);
  const isBuy = data.side === "bid";
  const notional = data.price * data.size;

  return (
    <>
      <DetailRow label="Side">
        <span className={isBuy ? "text-ember-green" : "text-ember-red"}>
          {isBuy ? "BUY" : "SELL"}
        </span>
      </DetailRow>
      <DetailRow label="Price">${formatPrice(data.price)}</DetailRow>
      <DetailRow label="Size">{formatSize(data.size, 4)}</DetailRow>
      <DetailRow label="Notional Value">${formatPrice(notional)}</DetailRow>
      <DetailRow label="Time">
        {ts.toLocaleString("en-US", {
          month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        })}
      </DetailRow>
    </>
  );
}
