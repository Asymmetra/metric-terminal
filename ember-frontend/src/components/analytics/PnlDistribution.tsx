"use client";

import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface PnlDistributionProps {
  authority: string;
}

interface Bucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

export function PnlDistribution({ authority }: PnlDistributionProps) {
  const [trades, setTrades] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getTraderTrades(authority, { limit: 500 })
      .then((res: any) => {
        const items = res.trades || res.data || [];
        setTrades(Array.isArray(items) ? items : []);
      })
      .catch(() => setTrades([]))
      .finally(() => setLoading(false));
  }, [authority]);

  const buckets = useMemo(() => {
    const pnls = trades
      .map((t) => t.pnl || 0)
      .filter((p) => p !== 0);

    if (pnls.length === 0) return [];

    const min = Math.min(...pnls);
    const max = Math.max(...pnls);
    const range = max - min;
    if (range === 0) return [{ label: formatUsd(min), min, max, count: pnls.length }];

    const numBuckets = Math.min(20, Math.max(6, Math.ceil(Math.sqrt(pnls.length))));
    const step = range / numBuckets;
    const result: Bucket[] = [];

    for (let i = 0; i < numBuckets; i++) {
      const bMin = min + i * step;
      const bMax = i === numBuckets - 1 ? max + 0.01 : min + (i + 1) * step;
      const count = pnls.filter((p) => p >= bMin && p < bMax).length;
      result.push({
        label: `${bMin >= 0 ? "+" : ""}${bMin.toFixed(0)}`,
        min: bMin,
        max: bMax,
        count,
      });
    }

    return result;
  }, [trades]);

  const maxCount = useMemo(() => Math.max(1, ...buckets.map((b) => b.count)), [buckets]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Computing PnL distribution...
        </span>
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No PnL data available</span>
      </div>
    );
  }

  return (
    <div className="border border-ember-border bg-surface-l1 p-4">
      <div className="mb-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          PnL Distribution
        </span>
      </div>

      <div className="flex items-end gap-[2px]" style={{ height: 100 }}>
        {buckets.map((b, i) => {
          const heightPct = (b.count / maxCount) * 100;
          const midpoint = (b.min + b.max) / 2;
          const isProfit = midpoint >= 0;

          return (
            <div key={i} className="group relative flex flex-1 flex-col items-center">
              <div className="relative w-full" style={{ height: 100 }}>
                <div
                  className={clsx(
                    "absolute bottom-0 w-full transition-opacity group-hover:opacity-80",
                    b.count === 0
                      ? "bg-surface-l2/20"
                      : isProfit
                      ? "bg-ember-green/60"
                      : "bg-ember-red/60"
                  )}
                  style={{ height: `${Math.max(heightPct, 1)}%` }}
                />
              </div>

              {/* Tooltip */}
              <div className="pointer-events-none absolute -top-12 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap border border-ember-border bg-surface-l2 px-2 py-1 shadow-lg group-hover:block">
                <div className="font-mono text-[9px] text-text-secondary">
                  {formatUsd(b.min)} to {formatUsd(b.max)}
                </div>
                <div className="font-mono text-[9px] text-text-primary">
                  {b.count} trades
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div className="mt-1 flex justify-between">
        <span className="font-mono text-[8px] text-ember-red/60">
          {formatUsd(buckets[0]?.min || 0)}
        </span>
        <span className="font-mono text-[8px] text-text-secondary/40">$0</span>
        <span className="font-mono text-[8px] text-ember-green/60">
          {formatUsd(buckets[buckets.length - 1]?.max || 0)}
        </span>
      </div>
    </div>
  );
}
