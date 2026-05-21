"use client";

import { useMemo } from "react";
import { useOrderbookStore, type DepthLevel } from "@/stores/orderbookStore";
import { useMarketStore } from "@/stores/marketStore";
import { formatPriceAuto, formatSize } from "@/lib/format";

const ROWS = 12;

function cumulative(levels: DepthLevel[]): { level: DepthLevel; total: number; pct: number }[] {
  let run = 0;
  const out = levels.map((level) => {
    run += level.size;
    return { level, total: run };
  });
  const max = run || 1;
  return out.map((r) => ({ ...r, pct: r.total / max }));
}

export function Orderbook() {
  const snapshot = useOrderbookStore((s) => s.snapshot);
  const selected = useMarketStore((s) => s.selectedSymbol);
  const market = useMarketStore((s) => s.markets.find((m) => m.symbol === selected));

  const { asks, bids } = useMemo(() => {
    if (!snapshot) return { asks: [], bids: [] };
    const asks = cumulative([...snapshot.asks].sort((a, b) => a.price - b.price).slice(0, ROWS)).reverse();
    const bids = cumulative([...snapshot.bids].sort((a, b) => b.price - a.price).slice(0, ROWS));
    return { asks, bids };
  }, [snapshot]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-metric-border bg-surface-1 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-secondary">Order Book</span>
        <span className="font-mono text-[9px] uppercase text-text-secondary/50">Phoenix</span>
      </div>

      {!snapshot ? (
        <div className="flex flex-1 items-center justify-center px-3 text-center font-mono text-[11px] text-text-secondary/50">
          {market && !market.phoenix ? "No order book — AMM venue routing" : "Waiting for depth…"}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <div className="grid grid-cols-3 px-3 pb-1 font-mono text-[9px] uppercase text-text-secondary/40">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Total</span>
          </div>
          <div className="flex flex-col">
            {asks.map((r, i) => (
              <DepthRow key={`a${i}`} r={r} side="ask" />
            ))}
          </div>
          <div className="border-y border-metric-border/50 px-3 py-1 text-center font-mono text-[12px] text-text-primary">
            ${formatPriceAuto(snapshot.mid)} <span className="text-[9px] text-text-secondary/50">mid</span>
          </div>
          <div className="flex flex-col">
            {bids.map((r, i) => (
              <DepthRow key={`b${i}`} r={r} side="bid" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DepthRow({ r, side }: { r: { level: DepthLevel; total: number; pct: number }; side: "ask" | "bid" }) {
  const color = side === "ask" ? "text-metric-sell" : "text-metric-buy";
  const bar = side === "ask" ? "rgba(249,115,22,0.12)" : "rgba(34,211,238,0.12)";
  return (
    <div className="relative grid grid-cols-3 px-3 py-0.5 font-mono text-[11px]">
      <div className="absolute inset-y-0 right-0" style={{ width: `${r.pct * 100}%`, background: bar }} />
      <span className={`relative ${color}`}>{formatPriceAuto(r.level.price)}</span>
      <span className="relative text-right text-text-secondary">{formatSize(r.level.size, 2)}</span>
      <span className="relative text-right text-text-secondary/70">{formatSize(r.total, 1)}</span>
    </div>
  );
}
