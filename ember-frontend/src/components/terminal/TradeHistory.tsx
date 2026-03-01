"use client";

import { useTradeStore } from "@/stores/tradeStore";
import { useTradeDetailStore } from "@/stores/tradeDetailStore";
import { formatPrice, formatSize } from "@/lib/format";

export function TradeHistory() {
  const trades = useTradeStore((s) => s.trades);
  const openRecentTrade = useTradeDetailStore((s) => s.openRecentTrade);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Column headers */}
      <div className="grid grid-cols-3 px-2 py-1 text-[10px] text-text-secondary/70">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>

      {/* Trade rows */}
      <div className="flex-1 overflow-y-auto">
        {trades.map((trade, i) => (
          <div
            key={`${trade.timestamp}-${trade.price}-${trade.size}-${i}`}
            onClick={() => openRecentTrade(trade)}
            className="grid cursor-pointer grid-cols-3 px-2 font-mono text-[11px] leading-none transition-colors hover:bg-surface-l2/40 trade-slide-in"
            style={{ height: "22px", alignItems: "center" }}
          >
            <span className={trade.side === "bid" ? "text-ember-green" : "text-ember-red"}>
              {formatPrice(trade.price)}
            </span>
            <span className="text-right text-text-primary/90">{formatSize(trade.size)}</span>
            <span className="text-right text-text-secondary/60">
              {(() => {
                const ts = typeof trade.timestamp === "string"
                  ? new Date(trade.timestamp)
                  : new Date(trade.timestamp * 1000);
                return ts.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                });
              })()}
            </span>
          </div>
        ))}

        {trades.length === 0 && (
          <div className="flex items-center justify-center py-12 text-[11px] text-text-secondary/50">
            Waiting for trades...
          </div>
        )}
      </div>
    </div>
  );
}
