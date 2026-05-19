"use client";

import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface ExposureChartProps {
  authority: string;
}

interface MarketExposure {
  symbol: string;
  notional: number;
  side: string;
  percentage: number;
}

const RING_COLORS = [
  "#0EA5E9", "#22D3EE", "#8B5CF6", "#F97316", "#3B82F6",
  "#F59E0B", "#EC4899", "#14B8A6", "#6366F1", "#EF4444",
];

export function ExposureChart({ authority }: ExposureChartProps) {
  const [exposures, setExposures] = useState<MarketExposure[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getTrader(authority)
      .then((res: any) => {
        const accounts: any[] = res.accounts || [];
        const marketMap = new Map<string, { notional: number; side: string }>();

        for (const acct of accounts) {
          for (const pos of acct.positions || []) {
            const symbol = pos.marketSymbol || pos.symbol || "Unknown";
            const size = parseFloat(pos.positionSize?.ui ?? pos.positionSize ?? "0") || 0;
            const entry = parseFloat(pos.entryPrice?.ui ?? pos.entryPrice ?? "0") || 0;
            const notional = Math.abs(size * entry);
            const side = size >= 0 ? "Long" : "Short";

            const existing = marketMap.get(symbol);
            if (existing) {
              existing.notional += notional;
            } else {
              marketMap.set(symbol, { notional, side });
            }
          }
        }

        const totalNotional = Array.from(marketMap.values()).reduce((s, v) => s + v.notional, 0);
        const items: MarketExposure[] = Array.from(marketMap.entries())
          .map(([symbol, data]) => ({
            symbol,
            notional: data.notional,
            side: data.side,
            percentage: totalNotional > 0 ? (data.notional / totalNotional) * 100 : 0,
          }))
          .sort((a, b) => b.notional - a.notional);

        setExposures(items);
      })
      .catch(() => setExposures([]))
      .finally(() => setLoading(false));
  }, [authority]);

  const totalNotional = useMemo(
    () => exposures.reduce((s, e) => s + e.notional, 0),
    [exposures]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading exposure data...
        </span>
      </div>
    );
  }

  if (exposures.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No open positions</span>
      </div>
    );
  }

  // Build conic gradient for donut chart
  const gradientParts: string[] = [];
  let cumPct = 0;
  exposures.forEach((e, i) => {
    const color = RING_COLORS[i % RING_COLORS.length];
    const start = cumPct;
    cumPct += e.percentage;
    gradientParts.push(`${color} ${start}% ${cumPct}%`);
  });
  const gradient = `conic-gradient(${gradientParts.join(", ")})`;

  return (
    <div className="border border-metric-border bg-surface-1 p-4">
      <div className="mb-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          Market Exposure
        </span>
      </div>

      <div className="flex items-center gap-6">
        {/* Donut chart */}
        <div className="relative flex-shrink-0">
          <div
            className="h-24 w-24 rounded-full"
            style={{ background: gradient }}
          />
          <div className="absolute inset-3 flex items-center justify-center rounded-full bg-surface-1">
            <div className="text-center">
              <div className="font-mono text-[9px] text-text-secondary/50">Total</div>
              <div className="font-mono text-[10px] text-text-primary">{formatUsd(totalNotional)}</div>
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-col gap-1.5 flex-1">
          {exposures.map((e, i) => (
            <div key={e.symbol} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: RING_COLORS[i % RING_COLORS.length] }}
                />
                <span className="font-mono text-[10px] text-text-primary">{e.symbol}</span>
                <span
                  className={clsx(
                    "font-mono text-[9px]",
                    e.side === "Long" ? "text-metric-buy" : "text-metric-sell"
                  )}
                >
                  {e.side}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] tabular-nums text-text-secondary">
                  {formatUsd(e.notional)}
                </span>
                <span className="font-mono text-[9px] text-text-secondary/50">
                  {e.percentage.toFixed(1)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
