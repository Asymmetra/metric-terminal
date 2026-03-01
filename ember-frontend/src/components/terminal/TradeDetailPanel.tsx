"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTradeDetailStore } from "@/stores/tradeDetailStore";
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

  return (
    <>
      <DetailRow label="Symbol">{data.symbol}-PERP</DetailRow>
      <DetailRow label="Side">
        <span className={isLong ? "text-ember-green" : "text-ember-red"}>
          {data.side.toUpperCase()}
        </span>
      </DetailRow>
      <DetailRow label="Size">{formatSize(data.size, 2)}</DetailRow>
      <DetailRow label="Entry Price">${formatPrice(data.entry_price)}</DetailRow>
      <DetailRow label="Mark Price">${formatPrice(data.mark_price)}</DetailRow>
      <DetailRow label="Unrealized PnL">
        <span className={clsx(data.unrealized_pnl >= 0 ? "text-ember-green" : "text-ember-red")}>
          {data.unrealized_pnl >= 0 ? "+" : ""}{formatUsd(data.unrealized_pnl)}
        </span>
      </DetailRow>
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
      {data.margin_mode === "isolated" && (
        <DetailRow label="Collateral">${formatPrice(data.allocated_collateral)}</DetailRow>
      )}
      <DetailRow label="Subaccount">{data.subaccount_index}</DetailRow>
      <DetailRow label="Take Profit">
        {data.tp_price != null
          ? <span className="text-ember-green">${formatPrice(data.tp_price)}</span>
          : <span className="text-text-secondary/30">—</span>}
      </DetailRow>
      <DetailRow label="Stop Loss">
        {data.sl_price != null
          ? <span className="text-ember-red">${formatPrice(data.sl_price)}</span>
          : <span className="text-text-secondary/30">—</span>}
      </DetailRow>
    </>
  );
}

function TradeHistoryDetail({ data }: { data: import("@/types/trader").TradeHistoryItem }) {
  return (
    <>
      <DetailRow label="Symbol">{data.marketSymbol}-PERP</DetailRow>
      <DetailRow label="Price">${formatPrice(parseFloat(data.price))}</DetailRow>
      <DetailRow label="Base Qty">{formatSize(parseFloat(data.baseQty), 4)}</DetailRow>
      <DetailRow label="Quote Qty">${formatPrice(parseFloat(data.quoteQty))}</DetailRow>
      <DetailRow label="Type">{data.instructionType}</DetailRow>
      <DetailRow label="Time">
        {new Date(data.timestamp).toLocaleString()}
      </DetailRow>
      <DetailRow label="TX Signature">
        <a
          href={`https://solscan.io/tx/${data.transactionSignature}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ember-orange hover:underline truncate max-w-[200px] inline-block"
        >
          {data.transactionSignature.slice(0, 8)}...{data.transactionSignature.slice(-8)}
        </a>
      </DetailRow>
    </>
  );
}

function RecentTradeDetail({ data }: { data: import("@/types/market").Trade }) {
  const ts = typeof data.timestamp === "string"
    ? new Date(data.timestamp)
    : new Date(data.timestamp * 1000);

  return (
    <>
      <DetailRow label="Price">${formatPrice(data.price)}</DetailRow>
      <DetailRow label="Size">{formatSize(data.size)}</DetailRow>
      <DetailRow label="Side">
        <span className={data.side === "bid" ? "text-ember-green" : "text-ember-red"}>
          {data.side === "bid" ? "BUY" : "SELL"}
        </span>
      </DetailRow>
      <DetailRow label="Time">{ts.toLocaleString()}</DetailRow>
    </>
  );
}
