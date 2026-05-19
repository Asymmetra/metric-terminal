"use client";

import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface ActivityHeatmapProps {
  authority: string;
}

interface DayData {
  date: string;
  tradeCount: number;
  pnl: number;
}

export function ActivityHeatmap({ authority }: ActivityHeatmapProps) {
  const [dayMap, setDayMap] = useState<Map<string, DayData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"activity" | "pnl">("activity");
  const [tooltip, setTooltip] = useState<{ data: DayData; x: number; y: number } | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      const map = new Map<string, DayData>();

      // Fetch daily PnL
      try {
        const pnlRes = await api.getTraderPnl(authority, "1d", 365);
        const points: any[] = pnlRes.data || [];
        for (let i = 0; i < points.length; i++) {
          const curr = points[i].cumulative_pnl || 0;
          const prev = i > 0 ? points[i - 1].cumulative_pnl || 0 : curr;
          const date = new Date(points[i].timestamp).toISOString().slice(0, 10);
          const existing = map.get(date) || { date, tradeCount: 0, pnl: 0 };
          existing.pnl = i === 0 ? 0 : curr - prev;
          map.set(date, existing);
        }
      } catch { /* ignore */ }

      // Fetch trades for count by day
      try {
        let cursor: string | undefined;
        let done = false;
        while (!done) {
          const res = await api.getTraderTrades(authority, { cursor, limit: 100 });
          const items: any[] = res.trades || res.data || [];
          if (!Array.isArray(items) || items.length === 0) break;
          for (const t of items) {
            if (!t.timestamp) continue;
            const date = new Date(t.timestamp).toISOString().slice(0, 10);
            const existing = map.get(date) || { date, tradeCount: 0, pnl: 0 };
            existing.tradeCount++;
            map.set(date, existing);
          }
          cursor = res.next_cursor || res.cursor;
          if (!cursor || !res.has_more || map.size > 365) done = true;
        }
      } catch { /* ignore */ }

      setDayMap(map);
      setLoading(false);
    };

    fetchData();
  }, [authority]);

  const { weeks } = useMemo(() => {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 364);
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const allWeeks: { date: Date; data: DayData | null }[][] = [];
    let currentWeek: { date: Date; data: DayData | null }[] = [];

    const cursor = new Date(startDate);
    while (cursor <= today) {
      const dateStr = cursor.toISOString().slice(0, 10);
      if (cursor.getDay() === 0 && currentWeek.length > 0) {
        allWeeks.push(currentWeek);
        currentWeek = [];
      }
      currentWeek.push({
        date: new Date(cursor),
        data: dayMap.get(dateStr) || null,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) allWeeks.push(currentWeek);
    return { weeks: allWeeks };
  }, [dayMap]);

  const maxCount = useMemo(() => {
    let max = 1;
    dayMap.forEach((d) => { if (d.tradeCount > max) max = d.tradeCount; });
    return max;
  }, [dayMap]);

  const maxAbsPnl = useMemo(() => {
    let max = 1;
    dayMap.forEach((d) => { if (Math.abs(d.pnl) > max) max = Math.abs(d.pnl); });
    return max;
  }, [dayMap]);

  function getCellColor(data: DayData | null): string {
    if (!data) return "bg-surface-2/20";
    if (mode === "activity") {
      if (data.tradeCount === 0) return "bg-surface-2/30";
      const intensity = data.tradeCount / maxCount;
      if (intensity > 0.75) return "bg-metric-buy";
      if (intensity > 0.5) return "bg-metric-buy/60";
      if (intensity > 0.25) return "bg-metric-buy/35";
      return "bg-metric-buy/15";
    }
    if (data.pnl === 0) return "bg-surface-2/30";
    const intensity = Math.min(Math.abs(data.pnl) / maxAbsPnl, 1);
    if (data.pnl > 0) {
      return intensity > 0.5 ? "bg-metric-buy" : "bg-metric-buy/40";
    }
    return intensity > 0.5 ? "bg-metric-sell" : "bg-metric-sell/40";
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-6">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Building activity map...
        </span>
      </div>
    );
  }

  return (
    <div className="border border-metric-border bg-surface-1 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          Trading Activity
        </span>
        <div className="flex gap-1">
          {(["activity", "pnl"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                "px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors",
                mode === m
                  ? "bg-metric-primary/10 text-metric-primary"
                  : "text-text-secondary/50 hover:text-text-secondary"
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="flex gap-[2px]">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[2px]">
              {Array.from({ length: 7 }, (_, di) => {
                const cell = week.find((c) => c.date.getDay() === di);
                if (!cell) return <div key={di} className="h-[10px] w-[10px]" />;

                return (
                  <div
                    key={di}
                    className={clsx(
                      "h-[10px] w-[10px] cursor-pointer transition-opacity hover:opacity-75",
                      getCellColor(cell.data)
                    )}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTooltip({
                        data: cell.data || { date: cell.date.toISOString().slice(0, 10), tradeCount: 0, pnl: 0 },
                        x: rect.left,
                        y: rect.top - 48,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {tooltip && (
        <div
          className="fixed z-50 border border-metric-border bg-surface-2 px-2 py-1 shadow-lg pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-mono text-[9px] text-text-secondary">{tooltip.data.date}</div>
          <div className="font-mono text-[9px] text-text-primary">{tooltip.data.tradeCount} trades</div>
          <div className={clsx("font-mono text-[9px]", tooltip.data.pnl >= 0 ? "text-metric-buy" : "text-metric-sell")}>
            {tooltip.data.pnl >= 0 ? "+" : ""}{formatUsd(tooltip.data.pnl)}
          </div>
        </div>
      )}
    </div>
  );
}
