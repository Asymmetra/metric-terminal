"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi, ISeriesApi, AreaSeriesPartialOptions } from "lightweight-charts";
import { api } from "@/lib/api";
import { COLORS } from "@/lib/constants";
import clsx from "clsx";

interface PnlPoint {
  timestamp: string;
  cumulative_pnl: number;
  unrealized_pnl: number;
  cumulative_funding_payment: number;
  cumulative_taker_fee: number;
}

const RESOLUTIONS = ["1h", "4h", "1d"] as const;
const RANGES = [
  { label: "1D", resolution: "1h" as const, limit: 24 },
  { label: "1W", resolution: "1h" as const, limit: 168 },
  { label: "1M", resolution: "4h" as const, limit: 180 },
  { label: "ALL", resolution: "1d" as const, limit: 1000 },
];

interface PnlChartProps {
  authority: string;
}

export function PnlChart({ authority }: PnlChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const [activeRange, setActiveRange] = useState(1); // default 1W
  const [data, setData] = useState<PnlPoint[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch data
  useEffect(() => {
    const range = RANGES[activeRange];
    setLoading(true);
    api
      .getTraderPnl(authority, range.resolution, range.limit)
      .then((res: any) => {
        setData(res.data || []);
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [authority, activeRange]);

  // Create chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: COLORS.textSecondary,
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(42,43,51,0.4)" },
        horzLines: { color: "rgba(42,43,51,0.4)" },
      },
      crosshair: {
        horzLine: { color: COLORS.emberOrange, width: 1, style: 2 },
        vertLine: { color: COLORS.emberOrange, width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: COLORS.emberBorder,
      },
      timeScale: {
        borderColor: COLORS.emberBorder,
        timeVisible: true,
      },
      handleScroll: false,
      handleScale: false,
    });

    const positive = data.length > 0 && data[data.length - 1].cumulative_pnl >= 0;
    const lineColor = positive ? COLORS.emberGreen : COLORS.emberRed;

    const series = chart.addAreaSeries({
      lineColor,
      topColor: positive ? "rgba(34,211,238,0.2)" : "rgba(249,115,22,0.2)",
      bottomColor: "transparent",
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (v: number) => `$${v.toFixed(2)}` },
    } as AreaSeriesPartialOptions);

    const chartData = data.map((d, i) => ({
      time: (Math.floor(new Date(d.timestamp).getTime() / 1000)) as any,
      value: d.cumulative_pnl,
    }));

    if (chartData.length > 0) {
      series.setData(chartData);
      chart.timeScale().fitContent();
    }

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width, height });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [data]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-metric-border px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          Cumulative PnL
        </span>
        <div className="flex gap-1">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setActiveRange(i)}
              className={clsx(
                "px-2 py-0.5 font-mono text-[10px] transition-colors",
                activeRange === i
                  ? "bg-metric-primary/10 text-metric-primary"
                  : "text-text-secondary/60 hover:text-text-secondary"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
              Loading PnL data...
            </span>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
