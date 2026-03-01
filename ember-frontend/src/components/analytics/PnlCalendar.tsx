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

interface MonthBlock {
  label: string;
  year: number;
  weeks: { date: Date; pnl: number | null }[][];
}

export function PnlCalendar({ authority }: PnlCalendarProps) {
  const [data, setData] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
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

  const allMonths = useMemo(() => {
    const pnlMap = new Map(data.map((d) => [d.date, d.pnl]));
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 364);
    startDate.setDate(1); // Align to first of month

    const months: MonthBlock[] = [];
    const cursor = new Date(startDate);

    while (cursor <= today) {
      const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const label = monthStart.toLocaleDateString("en-US", { month: "short" });
      const year = monthStart.getFullYear();

      // Build weeks for this month
      const weeks: { date: Date; pnl: number | null }[][] = [];
      let currentWeek: { date: Date; pnl: number | null }[] = [];

      // Pad start of first week
      const firstDayOfWeek = monthStart.getDay();
      for (let i = 0; i < firstDayOfWeek; i++) {
        currentWeek.push({ date: new Date(0), pnl: null }); // placeholder
      }

      const day = new Date(monthStart);
      while (day <= monthEnd && day <= today) {
        const dateStr = day.toISOString().slice(0, 10);
        if (day.getDay() === 0 && currentWeek.length > 0) {
          weeks.push(currentWeek);
          currentWeek = [];
        }
        currentWeek.push({
          date: new Date(day),
          pnl: pnlMap.has(dateStr) ? pnlMap.get(dateStr)! : null,
        });
        day.setDate(day.getDate() + 1);
      }

      // Pad end of last week
      while (currentWeek.length < 7) {
        currentWeek.push({ date: new Date(0), pnl: null });
      }
      if (currentWeek.length > 0) weeks.push(currentWeek);

      months.push({ label, year, weeks });

      // Move to next month
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return months;
  }, [data]);

  const visibleMonths = useMemo(() => {
    if (expanded) return allMonths;
    return allMonths.slice(-3);
  }, [allMonths, expanded]);

  const maxAbsPnl = useMemo(() => {
    const vals = data.map((d) => Math.abs(d.pnl)).filter((v) => v > 0);
    return vals.length > 0 ? Math.max(...vals) : 1;
  }, [data]);

  function getCellColor(pnl: number | null, isPlaceholder: boolean): string {
    if (isPlaceholder) return "bg-transparent";
    if (pnl === null) return "bg-[#1E1F25] border border-[#2A2B33]/50";
    if (pnl === 0) return "bg-[#2A2B33] border border-[#2A2B33]";
    const intensity = Math.min(Math.abs(pnl) / maxAbsPnl, 1);
    if (pnl > 0) {
      if (intensity > 0.75) return "bg-ember-green border border-ember-green/60";
      if (intensity > 0.5) return "bg-ember-green/70 border border-ember-green/40";
      if (intensity > 0.25) return "bg-ember-green/40 border border-ember-green/25";
      return "bg-ember-green/20 border border-ember-green/15";
    }
    if (intensity > 0.75) return "bg-ember-red border border-ember-red/60";
    if (intensity > 0.5) return "bg-ember-red/70 border border-ember-red/40";
    if (intensity > 0.25) return "bg-ember-red/40 border border-ember-red/25";
    return "bg-ember-red/20 border border-ember-red/15";
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-6">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading PnL calendar...
        </span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center p-6">
        <span className="font-mono text-[10px] text-text-secondary/40">No data available</span>
      </div>
    );
  }

  return (
    <div className="border border-ember-border bg-surface-l1 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
          Daily PnL
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="font-mono text-[8px] text-text-secondary/40">Loss</span>
            <span className="h-2 w-2 rounded-[1px] bg-ember-red/30 border border-ember-red/20" />
            <span className="h-2 w-2 rounded-[1px] bg-ember-red border border-ember-red/60" />
            <span className="h-2 w-2 rounded-[1px] bg-[#2A2B33] border border-[#2A2B33]" />
            <span className="h-2 w-2 rounded-[1px] bg-ember-green/30 border border-ember-green/20" />
            <span className="h-2 w-2 rounded-[1px] bg-ember-green border border-ember-green/60" />
            <span className="font-mono text-[8px] text-text-secondary/40">Profit</span>
          </div>
          {allMonths.length > 3 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="font-mono text-[9px] text-ember-orange/70 hover:text-ember-orange transition-colors"
            >
              {expanded ? "Show 3 months" : `Show all (${allMonths.length}mo)`}
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-4 overflow-x-auto">
        {visibleMonths.map((month, mi) => (
          <div key={`${month.label}-${month.year}-${mi}`} className="flex-shrink-0">
            {/* Month header */}
            <div className="mb-1.5 flex items-baseline gap-1">
              <span className="font-mono text-[10px] font-medium text-text-primary">
                {month.label}
              </span>
              <span className="font-mono text-[8px] text-text-secondary/40">
                {month.year}
              </span>
            </div>

            {/* Day labels + grid */}
            <div className="flex gap-[2px]">
              {/* Day-of-week labels */}
              <div className="flex flex-col gap-[2px] mr-0.5">
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <div key={i} className="h-[12px] w-3 flex items-center justify-end">
                    <span className="font-mono text-[7px] text-text-secondary/25">{d}</span>
                  </div>
                ))}
              </div>

              {/* Week columns */}
              {month.weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-[2px]">
                  {week.map((cell, ci) => {
                    const isPlaceholder = cell.date.getTime() === 0;
                    if (isPlaceholder) {
                      return <div key={ci} className="h-[12px] w-[12px]" />;
                    }
                    return (
                      <div
                        key={ci}
                        className={clsx(
                          "h-[12px] w-[12px] rounded-[1px] cursor-pointer transition-all hover:brightness-125 hover:scale-110",
                          getCellColor(cell.pnl, false)
                        )}
                        onMouseEnter={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setTooltip({
                            date: cell.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
                            pnl: cell.pnl || 0,
                            x: rect.left + rect.width / 2,
                            y: rect.top - 44,
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
        ))}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 -translate-x-1/2 px-2.5 py-1.5 border border-ember-border bg-surface-l2 shadow-lg pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-mono text-[9px] text-text-secondary">{tooltip.date}</div>
          <div
            className={clsx(
              "font-mono text-[10px] font-medium",
              tooltip.pnl > 0 ? "text-ember-green" : tooltip.pnl < 0 ? "text-ember-red" : "text-text-secondary/60"
            )}
          >
            {tooltip.pnl > 0 ? "+" : ""}{formatUsd(tooltip.pnl)}
          </div>
        </div>
      )}
    </div>
  );
}
