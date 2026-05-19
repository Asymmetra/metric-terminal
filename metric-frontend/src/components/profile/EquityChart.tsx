"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { COLORS } from "@/lib/constants";
import { formatUsd } from "@/lib/format";
import {
  normalizePnlSeries,
  pnlResolutionForPeriod,
  type Period,
  type PnlPoint,
} from "@/lib/tradeStats";
import clsx from "clsx";

type Overlay = "pnl" | "drawdown";

const WINDOWS: Period[] = ["24h", "7d", "30d", "all"];
const WINDOW_LABELS: Record<Period, string> = {
  "24h": "1D",
  "7d": "7D",
  "30d": "30D",
  all: "All",
};

interface Props {
  authority: string;
  period: Period;
}

// Equity curve as an area series under the cumulative-PnL line, with an
// optional drawdown overlay. Built on lightweight-charts to keep the look
// consistent with the candles chart. Axis labels stay subtle; big number
// lives in the header.
export function EquityChart({ authority, period }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const [overlay, setOverlay] = useState<Overlay>("pnl");
  const [chartWindow, setChartWindow] = useState<Period>(period);
  const [summary, setSummary] = useState<{ start: number; end: number; max: number; drawdown: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [points, setPoints] = useState<PnlPoint[]>([]);

  // Keep chart window in sync when page period changes — but only if the user
  // hasn't explicitly overridden it. We do this by resetting on period prop
  // change; any subsequent setChartWindow by the user wins until the next prop change.
  useEffect(() => {
    setChartWindow(period);
  }, [period]);

  // Fetch PnL for the chart's own window (independent from page period).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { resolution, limit } = pnlResolutionForPeriod(chartWindow);
    api
      .getTraderPnl(authority, resolution, limit)
      .then((res: any) => {
        if (cancelled) return;
        const pts = normalizePnlSeries(res?.data ?? []);
        setPoints(pts);
        if (pts.length > 0) {
          const start = pts[0].cumulativePnl;
          const end = pts[pts.length - 1].cumulativePnl;
          let peak = -Infinity;
          let drawdown = 0;
          for (const p of pts) {
            if (p.cumulativePnl > peak) peak = p.cumulativePnl;
            const dd = p.cumulativePnl - peak;
            if (dd < drawdown) drawdown = dd;
          }
          setSummary({ start, end, max: peak, drawdown });
        } else {
          setSummary(null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authority, period]);

  // Init chart once, resize on layout.
  useEffect(() => {
    if (!containerRef.current) return;
    let resizeObs: ResizeObserver | null = null;
    let disposed = false;
    (async () => {
      const { createChart, ColorType, CrosshairMode, LineStyle } = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      const chart = createChart(containerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: COLORS.surfaceL1 },
          textColor: COLORS.textSecondary,
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 9,
        },
        grid: {
          vertLines: { color: "rgba(42,43,51,0.4)" },
          horzLines: { color: "rgba(42,43,51,0.4)" },
        },
        crosshair: {
          mode: CrosshairMode.Magnet,
          vertLine: { color: "rgba(14,165,233,0.3)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: COLORS.emberOrange },
          horzLine: { color: "rgba(14,165,233,0.3)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: COLORS.surfaceL2 },
        },
        rightPriceScale: { borderColor: COLORS.emberBorder, textColor: COLORS.textSecondary, entireTextOnly: true },
        timeScale: {
          borderColor: COLORS.emberBorder,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
          fixLeftEdge: true,
          fixRightEdge: true,
          lockVisibleTimeRangeOnResize: true,
          shiftVisibleRangeOnNewBar: false,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          axisPressedMouseMove: { time: true, price: false },
          mouseWheel: true,
          pinch: true,
        },
        localization: {
          priceFormatter: (v: number) => formatUsd(v),
          timeFormatter: (t: number) =>
            new Date(t * 1000).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
        },
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      chartRef.current = chart;

      resizeObs = new ResizeObserver(() => {
        if (!containerRef.current || !chartRef.current) return;
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      });
      resizeObs.observe(containerRef.current);
    })();
    return () => {
      disposed = true;
      resizeObs?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Refetch when authority changes.
  useEffect(() => {
    setChartWindow(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authority]);

  // Paint the series when points / overlay change.
  useEffect(() => {
    if (!chartRef.current) return;
    (async () => {
      if (!chartRef.current) return;
      if (seriesRef.current) {
        chartRef.current.removeSeries(seriesRef.current);
        seriesRef.current = null;
      }
      const series = chartRef.current.addAreaSeries({
        lineColor: overlay === "drawdown" ? COLORS.emberRed : COLORS.emberGreen,
        topColor: overlay === "drawdown" ? "rgba(249,115,22,0.28)" : "rgba(34,211,238,0.28)",
        bottomColor: overlay === "drawdown" ? "rgba(249,115,22,0.02)" : "rgba(34,211,238,0.02)",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      if (overlay === "drawdown") {
        let peak = -Infinity;
        const dd = points.map((p) => {
          if (p.cumulativePnl > peak) peak = p.cumulativePnl;
          return { time: p.time as any, value: p.cumulativePnl - peak };
        });
        series.setData(dd);
      } else {
        series.setData(points.map((p) => ({ time: p.time as any, value: p.cumulativePnl })));
      }
      chartRef.current.timeScale().fitContent();
      seriesRef.current = series;
    })();
  }, [points, overlay]);

  const periodPnl = summary ? summary.end - summary.start : 0;
  const positive = periodPnl >= 0;

  return (
    <div className="border border-metric-border bg-surface-1">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-metric-border/60 px-4 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
            {overlay === "drawdown" ? "Drawdown" : "Cumulative PnL"}
          </span>
          <span
            className={clsx(
              "font-mono text-base font-semibold tabular-nums",
              overlay === "drawdown"
                ? summary && summary.drawdown < 0
                  ? "text-metric-sell"
                  : "text-text-primary"
                : positive
                  ? "text-metric-buy"
                  : "text-metric-sell"
            )}
          >
            {loading
              ? "…"
              : overlay === "drawdown"
                ? summary
                  ? formatUsd(summary.drawdown)
                  : "—"
                : summary
                  ? `${positive ? "+" : ""}${formatUsd(periodPnl)}`
                  : "—"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-px border border-metric-border/60 bg-metric-bg">
            {WINDOWS.map((w) => (
              <OverlayBtn
                key={w}
                label={WINDOW_LABELS[w]}
                active={chartWindow === w}
                onClick={() => setChartWindow(w)}
              />
            ))}
          </div>
          <div className="flex items-center gap-px border border-metric-border/60 bg-metric-bg">
            <OverlayBtn label="PnL" active={overlay === "pnl"} onClick={() => setOverlay("pnl")} />
            <OverlayBtn label="Drawdown" active={overlay === "drawdown"} onClick={() => setOverlay("drawdown")} />
          </div>
        </div>
      </div>
      <div ref={containerRef} className="relative h-[260px] w-full">
        {!loading && points.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[10px] text-text-secondary/40">No PnL history yet</span>
          </div>
        )}
      </div>
    </div>
  );
}

function OverlayBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
        active ? "bg-metric-primary/15 text-metric-primary" : "text-text-secondary/60 hover:text-text-secondary"
      )}
    >
      {label}
    </button>
  );
}
