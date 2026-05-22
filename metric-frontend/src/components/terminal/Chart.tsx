"use client";

import { useState } from "react";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";
import { TIMEFRAMES, type Timeframe } from "@/lib/phoenix-candles";
import { PriceChart, type ChartKind } from "./PriceChart";

/**
 * Chart shell: a toolbar (timeframe + candles/line toggle) over the PriceChart,
 * which renders either candlesticks or a filled line/area — both backfilled
 * from Phoenix candle history with a live mark-driven tip.
 */
export function Chart() {
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("1m");
  const [kind, setKind] = useState<ChartKind>("candles");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-metric-border/50 bg-surface-1 px-2 py-1">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setActiveTimeframe(tf.value)}
            className={clsx(
              "px-2 py-0.5 font-mono text-[10px] transition-colors",
              activeTimeframe === tf.value
                ? "bg-surface-2 text-metric-primary"
                : "text-text-secondary/60 hover:text-text-secondary"
            )}
          >
            {tf.label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1">
            {([
              ["candles", "Candles"],
              ["area", "Line"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                title={k === "candles" ? "Candlestick chart" : "Line chart"}
                className={clsx(
                  "px-2 py-0.5 font-mono text-[10px] transition-colors",
                  kind === k
                    ? "bg-surface-2 text-metric-primary"
                    : "text-text-secondary/60 hover:text-text-secondary"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="font-mono text-[10px] text-text-secondary/60">
            {selectedSymbol}/USD · Phoenix
          </span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <PriceChart symbol={selectedSymbol} timeframe={activeTimeframe} kind={kind} />
      </div>
    </div>
  );
}
