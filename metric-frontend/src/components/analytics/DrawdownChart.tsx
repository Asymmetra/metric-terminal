"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi } from "lightweight-charts";
import { api } from "@/lib/api";
import { COLORS } from "@/lib/constants";

interface DrawdownChartProps {
  authority: string;
}

export function DrawdownChart({ authority }: DrawdownChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [maxDrawdown, setMaxDrawdown] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    setLoading(true);
    api
      .getTraderPnl(authority, "1h", 1000)
      .then((res: any) => {
        const points: any[] = res.data || [];
        if (points.length === 0) {
          setLoading(false);
          return;
        }

        // Compute drawdown series
        let peak = -Infinity;
        let maxDd = 0;
        const drawdownData = points.map((p: any) => {
          const pnl = p.cumulative_pnl || 0;
          if (pnl > peak) peak = pnl;
          const dd = peak > 0 ? ((pnl - peak) / peak) * 100 : pnl - peak;
          if (dd < maxDd) maxDd = dd;
          return {
            time: Math.floor(new Date(p.timestamp).getTime() / 1000) as any,
            value: dd,
          };
        });

        setMaxDrawdown(maxDd);

        const chart = createChart(containerRef.current!, {
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
          rightPriceScale: { borderColor: COLORS.emberBorder },
          timeScale: { borderColor: COLORS.emberBorder, timeVisible: true },
          handleScroll: false,
          handleScale: false,
        });

        const series = chart.addAreaSeries({
          lineColor: COLORS.emberRed,
          topColor: "transparent",
          bottomColor: "rgba(249,115,22,0.15)",
          lineWidth: 2,
          priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(2)}%` },
        });

        series.setData(drawdownData);
        chart.timeScale().fitContent();
        chartRef.current = chart;

        const observer = new ResizeObserver((entries) => {
          const { width, height } = entries[0].contentRect;
          chart.applyOptions({ width, height });
        });
        observer.observe(containerRef.current!);

        setLoading(false);

        return () => {
          observer.disconnect();
          chart.remove();
          chartRef.current = null;
        };
      })
      .catch(() => setLoading(false));
  }, [authority]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-metric-border px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          Drawdown
        </span>
        {maxDrawdown < 0 && (
          <span className="font-mono text-[10px] text-metric-sell">
            Max: {maxDrawdown.toFixed(2)}%
          </span>
        )}
      </div>
      <div className="relative flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
              Computing drawdown...
            </span>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
