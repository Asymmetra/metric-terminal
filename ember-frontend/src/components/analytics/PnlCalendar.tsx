"use client";

import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface PnlCalendarProps {
  authority: string;
}

interface DayData {
  date: string;
  pnl: number;
}

export function PnlCalendar({ authority }: PnlCalendarProps) {
  const [data, setData] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{ date: string; pnl: number; x: number; y: number } | null>(null);

  useEffect(() => {
    api
      .getTraderPnl(authority, "1d", 365)
      .then((res: any) => {
        const points: any[] = res.data || [];
        const daily: DayData[] = [];
        for (let i = 0; i < points.length; i++) {
          const curr = points[i].cumulative_pnl || 0;
          const prev = i > 0 ? points[i - 1].cumulative_pnl || 0 : curr;
          const date = new Date(points[i].timestamp).toISOString().slice(0, 10);
          daily.push({ date, pnl: i === 0 ? 0 : curr - prev });
        }
        setData(daily);
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [authority]);

  const { weeks, months } = useMemo(() => {
    if (data.length === 0) return { weeks: [], months: [] };

    const pnlMap = new Map(data.map((d) => [d.date, d.pnl]));
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 364);
    // Align to start of week (Sunday)
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const allWeeks: { date: Date; pnl: number | null }[][] = [];
    const monthLabels: { label: string; col: number }[] = [];
    let currentWeek: { date: Date; pnl: number | null }[] = [];
    let lastMonth = -1;

    const cursor = new Date(startDate);
    while (cursor <= today) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dayOfWeek = cursor.getDay();

      if (dayOfWeek === 0 && currentWeek.length > 0) {
        allWeeks.push(currentWeek);
        currentWeek = [];
      }

      const month = cursor.getMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          label: cursor.toLocaleDateString("en-US", { month: "short" }),
          col: allWeeks.length,
        });
        lastMonth = month;
      }

      currentWeek.push({
        date: new Date(cursor),
        pnl: pnlMap.has(dateStr) ? pnlMap.get(dateStr)! : null,
      });

      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) allWeeks.push(currentWeek);

    return { weeks: allWeeks, months: monthLabels };
  }, [data]);

  const maxAbsPnl = useMemo(() => {
    const vals = data.map((d) => Math.abs(d.pnl)).filter((v) => v > 0);
    return vals.length > 0 ? Math.max(...vals) : 1;
  }, [data]);

  function getCellColor(pnl: number | null): string {
    if (pnl === null) return "bg-surface-l2/30";
    if (pnl === 0) return "bg-surface-l2";
    const intensity = Math.min(Math.abs(pnl) / maxAbsPnl, 1);
    if (pnl > 0) {
      if (intensity > 0.75) return "bg-ember-green";
      if (intensity > 0.5) return "bg-ember-green/70";
      if (intensity > 0.25) return "bg-ember-green/40";
      return "bg-ember-green/20";
    }
    if (intensity > 0.75) return "bg-ember-red";
    if (intensity > 0.5) return "bg-ember-red/70";
    if (intensity > 0.25) return "bg-ember-red/40";
    return "bg-ember-red/20";
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading PnL calendar...
        </span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No data available</span>
      </div>
    );
  }

  return (
    <div className="border border-ember-border bg-surface-l1 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          Daily PnL Calendar
        </span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[9px] text-text-secondary/40">Loss</span>
          <span className="h-2 w-2 bg-ember-red/40" />
          <span className="h-2 w-2 bg-ember-red" />
          <span className="h-2 w-2 bg-surface-l2" />
          <span className="h-2 w-2 bg-ember-green/40" />
          <span className="h-2 w-2 bg-ember-green" />
          <span className="font-mono text-[9px] text-text-secondary/40">Profit</span>
        </div>
      </div>

      <div className="relative overflow-x-auto">
        {/* Month labels */}
        <div className="flex gap-[2px] mb-1 ml-6">
          {months.map((m, i) => (
            <div
              key={`${m.label}-${i}`}
              className="font-mono text-[8px] text-text-secondary/40"
              style={{ position: "absolute", left: `${m.col * 13 + 24}px` }}
            >
              {m.label}
            </div>
          ))}
        </div>

        <div className="flex gap-[2px] mt-4">
          {/* Day labels */}
          <div className="flex flex-col gap-[2px] mr-1">
            {["", "M", "", "W", "", "F", ""].map((d, i) => (
              <div key={i} className="h-[11px] flex items-center">
                <span className="font-mono text-[8px] text-text-secondary/30 w-3">{d}</span>
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[2px]">
              {Array.from({ length: 7 }, (_, di) => {
                const cell = week.find((c) => c.date.getDay() === di);
                if (!cell) {
                  return <div key={di} className="h-[11px] w-[11px]" />;
                }
                return (
                  <div
                    key={di}
                    className={clsx("h-[11px] w-[11px] cursor-pointer transition-opacity hover:opacity-80", getCellColor(cell.pnl))}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTooltip({
                        date: cell.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
                        pnl: cell.pnl || 0,
                        x: rect.left,
                        y: rect.top - 40,
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

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-2 py-1 border border-ember-border bg-surface-l2 shadow-lg pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span className="font-mono text-[9px] text-text-secondary">{tooltip.date}: </span>
          <span
            className={clsx(
              "font-mono text-[9px] font-medium",
              tooltip.pnl > 0 ? "text-ember-green" : tooltip.pnl < 0 ? "text-ember-red" : "text-text-secondary"
            )}
          >
            {tooltip.pnl > 0 ? "+" : ""}{formatUsd(tooltip.pnl)}
          </span>
        </div>
      )}
    </div>
  );
}
