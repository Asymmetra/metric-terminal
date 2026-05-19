"use client";

import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import clsx from "clsx";

interface ActivityByHourProps {
  authority: string;
}

interface HourBucket {
  hour: number;
  count: number;
  totalPnl: number;
  avgPnl: number;
}

export function ActivityByHour({ authority }: ActivityByHourProps) {
  const [trades, setTrades] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let allTrades: any[] = [];
    let done = false;
    let currentCursor: string | undefined;

    const fetchAll = async () => {
      while (!done) {
        try {
          const res = await api.getTraderTrades(authority, { cursor: currentCursor, limit: 100 });
          const items = res.trades || res.data || [];
          if (!Array.isArray(items) || items.length === 0) {
            done = true;
            break;
          }
          allTrades = [...allTrades, ...items];
          currentCursor = res.next_cursor || res.cursor;
          if (!currentCursor || !res.has_more) done = true;
          // Cap at 1000 trades for performance
          if (allTrades.length >= 1000) done = true;
        } catch {
          done = true;
        }
      }
      setTrades(allTrades);
      setLoading(false);
    };

    fetchAll();
  }, [authority]);

  const buckets = useMemo(() => {
    const hours: HourBucket[] = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      count: 0,
      totalPnl: 0,
      avgPnl: 0,
    }));

    for (const t of trades) {
      const ts = t.timestamp ? new Date(t.timestamp) : null;
      if (!ts) continue;
      const h = ts.getUTCHours();
      hours[h].count++;
      hours[h].totalPnl += t.pnl || 0;
    }

    for (const b of hours) {
      b.avgPnl = b.count > 0 ? b.totalPnl / b.count : 0;
    }

    return hours;
  }, [trades]);

  const maxCount = useMemo(() => Math.max(1, ...buckets.map((b) => b.count)), [buckets]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Analyzing trade hours...
        </span>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No trade data</span>
      </div>
    );
  }

  return (
    <div className="border border-metric-border bg-surface-1 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          Activity by Hour (UTC)
        </span>
        <span className="font-mono text-[9px] text-text-secondary/40">
          {trades.length} trades analyzed
        </span>
      </div>

      <div className="flex items-end gap-[3px]" style={{ height: 120 }}>
        {buckets.map((b) => {
          const heightPct = maxCount > 0 ? (b.count / maxCount) * 100 : 0;
          const isProfit = b.avgPnl >= 0;

          return (
            <div key={b.hour} className="group relative flex flex-1 flex-col items-center">
              <div className="relative w-full" style={{ height: 120 }}>
                <div
                  className={clsx(
                    "absolute bottom-0 w-full transition-all group-hover:opacity-80",
                    b.count === 0
                      ? "bg-surface-2/30"
                      : isProfit
                      ? "bg-metric-buy/60"
                      : "bg-metric-sell/60"
                  )}
                  style={{ height: `${Math.max(heightPct, 2)}%` }}
                />
              </div>
              <span className="mt-1 font-mono text-[7px] text-text-secondary/40">
                {b.hour.toString().padStart(2, "0")}
              </span>

              {/* Tooltip on hover */}
              <div className="pointer-events-none absolute -top-14 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap border border-metric-border bg-surface-2 px-2 py-1 shadow-lg group-hover:block">
                <div className="font-mono text-[9px] text-text-secondary">
                  {b.hour.toString().padStart(2, "0")}:00 UTC
                </div>
                <div className="font-mono text-[9px] text-text-primary">
                  {b.count} trades
                </div>
                <div
                  className={clsx(
                    "font-mono text-[9px]",
                    b.avgPnl >= 0 ? "text-metric-buy" : "text-metric-sell"
                  )}
                >
                  avg {b.avgPnl >= 0 ? "+" : ""}${b.avgPnl.toFixed(2)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
