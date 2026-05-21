"use client";

import { useState } from "react";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";
import { TIMEFRAMES, type Timeframe } from "@/lib/phoenix-candles";
import { hasPythFeed } from "@/lib/pyth";
import { CandleChart } from "./CandleChart";
import { LiveLineChart, type LineSource } from "./LiveLineChart";

type ChartType = "candles" | "line";

const SOURCE_LABELS: Record<LineSource, string> = {
  mark: "Phoenix Mark",
  mid: "Phoenix Mid",
  pyth: "Pyth",
};

/**
 * Chart shell: a toolbar (chart-type toggle; timeframe for candles, data-source
 * for the line) over either the candlestick chart (lightweight-charts, Phoenix
 * OHLC) or the live-scrolling line (liveline).
 */
export function Chart() {
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("1m");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [lineSource, setLineSource] = useState<LineSource>("mark");

  // Pyth only offered for symbols with a known feed; default stays Phoenix.
  const sources: LineSource[] = hasPythFeed(selectedSymbol)
    ? ["mark", "mid", "pyth"]
    : ["mark", "mid"];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-metric-border/50 bg-surface-1 px-2 py-1">
        {/* Candle mode: timeframe. Line mode: data source (Phoenix default). */}
        {chartType === "candles"
          ? TIMEFRAMES.map((tf) => (
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
            ))
          : sources.map((src) => (
              <button
                key={src}
                onClick={() => setLineSource(src)}
                title={`Price source: ${SOURCE_LABELS[src]}`}
                className={clsx(
                  "px-2 py-0.5 font-mono text-[10px] transition-colors",
                  lineSource === src
                    ? "bg-surface-2 text-metric-primary"
                    : "text-text-secondary/60 hover:text-text-secondary"
                )}
              >
                {SOURCE_LABELS[src]}
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
          <LiveLineChart symbol={selectedSymbol} source={lineSource} />
        )}
      </div>
    </div>
  );
}
