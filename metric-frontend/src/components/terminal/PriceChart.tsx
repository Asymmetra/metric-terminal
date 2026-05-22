"use client";

import { useEffect, useRef, useState } from "react";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { COLORS } from "@/lib/constants";
import { fetchCandles, type Candle, type Timeframe } from "@/lib/phoenix-candles";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Series = any;

export type ChartKind = "candles" | "area";

const UP = COLORS.emberGreen; // metric-buy (cyan)
const DOWN = COLORS.emberRed; // metric-sell (orange)
const LINE = COLORS.emberOrange; // metric-primary (sky)
const VOL_UP = "rgba(34,211,238,0.15)";
const VOL_DOWN = "rgba(249,115,22,0.15)";

const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

/**
 * Price chart (lightweight-charts) fed by Phoenix candles — handles both the
 * candlestick view (trade OHLC) and the line/area view (mark-close), sharing
 * the same reliable plumbing: 300-bar historical backfill on load, scroll-back
 * pagination, volume, and a live in-progress point driven by the mark stream.
 *
 * The line/area view plots `markClose` so its history sits on the same basis
 * as the live mark that updates the tip — and it backfills immediately, so it
 * always presents with full context (no blank-then-grow live-ticker behavior).
 */
export function PriceChart({
  symbol,
  timeframe,
  kind,
}: {
  symbol: string;
  timeframe: Timeframe;
  kind: ChartKind;
}) {
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const priceSeriesRef = useRef<Series>(null);
  const volumeSeriesRef = useRef<Series>(null);
  const currentRef = useRef<Candle | null>(null);
  const allRef = useRef<Candle[]>([]);
  const loadingOlderRef = useRef(false);
  const noMoreOlderRef = useRef(false);
  const tfRef = useRef<Timeframe>(timeframe);
  tfRef.current = timeframe;
  const kindRef = useRef<ChartKind>(kind);
  kindRef.current = kind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLinesRef = useRef<any[]>([]);
  const [seriesEpoch, setSeriesEpoch] = useState(0);
  const positions = useTraderStore((s) => s.positions);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");

  useEffect(() => {
    if (!chartAreaRef.current) return;
    setStatus("loading");

    const isArea = kind === "area";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chart: any;
    let observer: ResizeObserver | null = null;
    const abort = new AbortController();
    // Guard against React's dev double-mount: if cleanup ran before the async
    // createChart resolved, bail so we don't leave an orphan chart in the
    // container (which renders blank/overlapping).
    let disposed = false;

    // Shape a candle for the active series.
    const toPoint = (c: Candle) => (isArea ? { time: c.time, value: c.markClose } : c);
    const toVol = (c: Candle) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? VOL_UP : VOL_DOWN,
    });

    async function initChart() {
      const { createChart, ColorType, CrosshairMode } = await import("lightweight-charts");
      if (disposed || !chartAreaRef.current) return;

      chart = createChart(chartAreaRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: COLORS.surfaceL1 },
          textColor: COLORS.textSecondary,
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10,
        },
        grid: {
          vertLines: { color: "rgba(51,65,85,0.4)" },
          horzLines: { color: "rgba(51,65,85,0.4)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "rgba(14,165,233,0.3)", width: 1, style: 2, labelBackgroundColor: COLORS.emberOrange },
          horzLine: { color: "rgba(14,165,233,0.3)", width: 1, style: 2, labelBackgroundColor: COLORS.surfaceL2 },
        },
        rightPriceScale: { borderColor: COLORS.emberBorder, textColor: COLORS.textSecondary, entireTextOnly: true },
        timeScale: {
          borderColor: COLORS.emberBorder,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
          barSpacing: 6,
          fixRightEdge: true,
        },
        localization: {
          timeFormatter: (ts: number) =>
            new Date(ts * 1000).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
        },
        width: chartAreaRef.current.clientWidth,
        height: chartAreaRef.current.clientHeight,
      });

      const priceSeries = isArea
        ? chart.addAreaSeries({
            lineColor: LINE,
            topColor: "rgba(14,165,233,0.35)",
            bottomColor: "rgba(14,165,233,0.02)",
            lineWidth: 2,
            priceLineVisible: true,
            lastValueVisible: true,
          })
        : chart.addCandlestickSeries({
            upColor: UP,
            downColor: DOWN,
            borderUpColor: UP,
            borderDownColor: DOWN,
            wickUpColor: UP,
            wickDownColor: DOWN,
          });
      priceSeriesRef.current = priceSeries;

      const volumeSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "" });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      volumeSeriesRef.current = volumeSeries;

      allRef.current = [];
      loadingOlderRef.current = false;
      noMoreOlderRef.current = false;

      try {
        const candles = await fetchCandles(symbol, tfRef.current, { limit: 300, signal: abort.signal });
        if (candles.length === 0) {
          setStatus("empty");
          return;
        }
        priceSeries.setData(candles.map(toPoint));
        volumeSeries.setData(candles.map(toVol));
        allRef.current = candles;
        currentRef.current = candles[candles.length - 1];
        setStatus("ready");
        setSeriesEpoch((n) => n + 1); // tell the price-line effect a fresh series exists
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.error("Failed to load candles:", e);
        setStatus("error");
      }

      async function loadOlder() {
        if (loadingOlderRef.current || noMoreOlderRef.current) return;
        if (allRef.current.length === 0) return;
        loadingOlderRef.current = true;
        try {
          const earliestSec = allRef.current[0].time;
          const older = await fetchCandles(symbol, tfRef.current, {
            limit: 300,
            before: earliestSec * 1000,
            signal: abort.signal,
          });
          const filtered = older.filter((c) => c.time < earliestSec);
          if (filtered.length === 0) {
            noMoreOlderRef.current = true;
            return;
          }
          const merged = [...filtered, ...allRef.current];
          allRef.current = merged;
          priceSeries.setData(merged.map(toPoint));
          volumeSeries.setData(merged.map(toVol));
        } catch {
          /* ignore */
        } finally {
          loadingOlderRef.current = false;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
        if (!range) return;
        const info = priceSeries.barsInLogicalRange(range);
        if (info && info.barsBefore < 15) void loadOlder();
      });

      observer = new ResizeObserver(() => {
        if (chartAreaRef.current) {
          chart.applyOptions({ width: chartAreaRef.current.clientWidth, height: chartAreaRef.current.clientHeight });
        }
      });
      observer.observe(chartAreaRef.current);
    }

    void initChart();

    return () => {
      disposed = true;
      abort.abort();
      observer?.disconnect();
      chart?.remove();
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      currentRef.current = null;
      priceLinesRef.current = [];
    };
  }, [symbol, timeframe, kind]);

  // Entry + liquidation price lines for an open position on this symbol.
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series) return;
    for (const l of priceLinesRef.current) {
      try {
        series.removePriceLine(l);
      } catch {
        /* series may be gone */
      }
    }
    priceLinesRef.current = [];

    const pos = positions.find(
      (p) => p.asset === symbol && (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0)
    );
    if (!pos) return;

    const addLine = (price: number, color: string, title: string) => {
      if (!(price > 0)) return;
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title })
      );
    };
    addLine(Number(pos.entryPrice), "#0EA5E9", "Entry");
    addLine(Number(pos.liquidationPrice), "#F97316", "Liq");
  }, [positions, symbol, seriesEpoch]);

  // Live in-progress point from the mark stream (OHLC for candles, value for area).
  useEffect(() => {
    let lastPrice = 0;
    const unsub = useStatsStore.subscribe((state) => {
      const mark = state.marks[symbol];
      if (!mark || mark === lastPrice || !priceSeriesRef.current) return;
      lastPrice = mark;

      const isArea = kindRef.current === "area";
      const interval = TF_SECONDS[tfRef.current] ?? 60;
      const bucket = Math.floor(Date.now() / 1000 / interval) * interval;
      const cur = currentRef.current;

      if (!cur || cur.time !== bucket) {
        const next: Candle = { time: bucket, open: mark, high: mark, low: mark, close: mark, markClose: mark, volume: 0 };
        currentRef.current = next;
        priceSeriesRef.current.update(isArea ? { time: bucket, value: mark } : next);
        volumeSeriesRef.current?.update({ time: bucket, value: 0, color: VOL_UP });
        return;
      }
      cur.close = mark;
      cur.markClose = mark;
      if (mark > cur.high) cur.high = mark;
      if (mark < cur.low) cur.low = mark;
      priceSeriesRef.current.update(isArea ? { time: cur.time, value: mark } : { ...cur });
    });
    return unsub;
  }, [symbol]);

  return (
    <div ref={chartAreaRef} className="relative h-full w-full">
      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-1/80">
          <span className="font-mono text-[11px] text-text-secondary/70">
            {status === "loading" && "Loading chart…"}
            {status === "empty" && `No Phoenix data for ${symbol}`}
            {status === "error" && "Failed to load chart data"}
          </span>
        </div>
      )}
    </div>
  );
}
