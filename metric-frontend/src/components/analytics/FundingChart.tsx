"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi } from "lightweight-charts";
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

const RANGES = [
  { label: "1W", resolution: "1h" as const, limit: 168 },
  { label: "1M", resolution: "4h" as const, limit: 180 },
  { label: "ALL", resolution: "1d" as const, limit: 1000 },
];

interface FundingChartProps {
  authority: string;
}

export function FundingChart({ authority }: FundingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [activeRange, setActiveRange] = useState(0);
  const [data, setData] = useState<PnlPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const range = RANGES[activeRange];
    setLoading(true);
    api
      .getTraderPnl(authority, range.resolution, range.limit)
      .then((res: any) => setData(res.data || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [authority, activeRange]);

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

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
      rightPriceScale: { borderColor: COLORS.emberBorder },
      timeScale: { borderColor: COLORS.emberBorder, timeVisible: true },
      handleScroll: false,
      handleScale: false,
    });

    const fundingSeries = chart.addAreaSeries({
      lineColor: "#8B5CF6",
      topColor: "rgba(139,92,246,0.2)",
      bottomColor: "transparent",
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (v: number) => `$${v.toFixed(2)}` },
      title: "Funding",
    });

    const feeSeries = chart.addAreaSeries({
      lineColor: COLORS.emberOrange,
      topColor: "rgba(14,165,233,0.15)",
      bottomColor: "transparent",
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (v: number) => `$${v.toFixed(2)}` },
      title: "Fees",
    });

    const fundingData = data.map((d) => ({
      time: (Math.floor(new Date(d.timestamp).getTime() / 1000)) as any,
      value: d.cumulative_funding_payment || 0,
    }));

    const feeData = data.map((d) => ({
      time: (Math.floor(new Date(d.timestamp).getTime() / 1000)) as any,
      value: Math.abs(d.cumulative_taker_fee || 0),
    }));

    fundingSeries.setData(fundingData);
    feeSeries.setData(feeData);
    chart.timeScale().fitContent();

    chartRef.current = chart;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width, height });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data]);

  const lastFunding = data.length > 0 ? data[data.length - 1].cumulative_funding_payment || 0 : 0;
  const lastFees = data.length > 0 ? Math.abs(data[data.length - 1].cumulative_taker_fee || 0) : 0;

  return (
    <div className="flex h-full flex-col border border-metric-border bg-surface-1">
      <div className="flex items-center justify-between border-b border-metric-border px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
            Funding & Fees
          </span>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[#8B5CF6]" />
              <span className={clsx("font-mono text-[10px]", lastFunding >= 0 ? "text-metric-buy" : "text-metric-sell")}>
                ${lastFunding.toFixed(2)}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-metric-primary" />
              <span className="font-mono text-[10px] text-text-secondary">
                ${lastFees.toFixed(2)}
              </span>
            </span>
          </div>
        </div>
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
      <div className="relative flex-1" style={{ minHeight: 200 }}>
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
              Loading funding data...
            </span>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
