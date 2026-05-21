"use client";

import { useState } from "react";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";
import { TIMEFRAMES, type Timeframe } from "@/lib/phoenix-candles";
import { CandleChart } from "./CandleChart";
import { LiveLineChart } from "./LiveLineChart";

type ChartType = "candles" | "line";

/**
 * Chart shell: a toolbar (chart-type toggle, timeframe for candles) over either
 * the candlestick chart (lightweight-charts, Phoenix OHLC) or the live-scrolling
 * line (liveline, continuous mark stream).
 */
export function Chart() {
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("1m");
  const [chartType, setChartType] = useState<ChartType>("candles");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-metric-border/50 bg-surface-1 px-2 py-1">
        {/* Timeframe — candle mode only (the line uses liveline's own window). */}
        {chartType === "candles" &&
          TIMEFRAMES.map((tf) => (
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
            {(["candles", "line"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setChartType(t)}
                title={t === "candles" ? "Candlestick chart" : "Live line chart"}
                className={clsx(
                  "px-2 py-0.5 font-mono text-[10px] capitalize transition-colors",
                  chartType === t
                    ? "bg-surface-2 text-metric-primary"
                    : "text-text-secondary/60 hover:text-text-secondary"
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="font-mono text-[10px] text-text-secondary/60">
            {selectedSymbol}/USD · Phoenix
          </span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {chartType === "candles" ? (
          <CandleChart symbol={selectedSymbol} timeframe={activeTimeframe} />
        ) : (
          <LiveLineChart symbol={selectedSymbol} />
        )}
      </div>
    </div>
  );
}
