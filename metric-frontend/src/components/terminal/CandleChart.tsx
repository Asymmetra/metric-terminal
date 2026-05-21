"use client";

import { useEffect, useRef, useState } from "react";
import { useStatsStore } from "@/stores/statsStore";
import { COLORS } from "@/lib/constants";
import { fetchCandles, type Candle, type Timeframe } from "@/lib/phoenix-candles";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Series = any;

const UP = COLORS.emberGreen; // metric-buy (cyan)
const DOWN = COLORS.emberRed; // metric-sell (orange)
const VOL_UP = "rgba(34,211,238,0.15)";
const VOL_DOWN = "rgba(249,115,22,0.15)";

const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

/**
 * Candlestick chart (lightweight-charts) fed by Phoenix candles: historical
 * OHLC + scroll-back pagination + volume, with the in-progress bar driven by
 * the live mark stream. Trade-OHLC basis (conventional for candlesticks).
 */
export function CandleChart({ symbol, timeframe }: { symbol: string; timeframe: Timeframe }) {
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const candleSeriesRef = useRef<Series>(null);
  const volumeSeriesRef = useRef<Series>(null);
  const currentCandleRef = useRef<Candle | null>(null);
  const allCandlesRef = useRef<Candle[]>([]);
  const loadingOlderRef = useRef(false);
  const noMoreOlderRef = useRef(false);
  const tfRef = useRef<Timeframe>(timeframe);
  tfRef.current = timeframe;
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");

  useEffect(() => {
    if (!chartAreaRef.current) return;
    setStatus("loading");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chart: any;
    let observer: ResizeObserver | null = null;
    const abort = new AbortController();

    async function initChart() {
      const { createChart, ColorType, CrosshairMode } = await import("lightweight-charts");
      if (!chartAreaRef.current) return;

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

      const candleSeries = chart.addCandlestickSeries({
        upColor: UP,
        downColor: DOWN,
        borderUpColor: UP,
        borderDownColor: DOWN,
        wickUpColor: UP,
        wickDownColor: DOWN,
      });
      candleSeriesRef.current = candleSeries;

      const volumeSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "" });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      volumeSeriesRef.current = volumeSeries;

      allCandlesRef.current = [];
      loadingOlderRef.current = false;
      noMoreOlderRef.current = false;

      try {
        const candles = await fetchCandles(symbol, tfRef.current, { limit: 300, signal: abort.signal });
        if (candles.length === 0) {
          setStatus("empty");
          return;
        }
        candleSeries.setData(candles);
        volumeSeries.setData(
          candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? VOL_UP : VOL_DOWN }))
        );
        allCandlesRef.current = candles;
        currentCandleRef.current = candles[candles.length - 1];
        setStatus("ready");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.error("Failed to load candles:", e);
        setStatus("error");
      }

      async function loadOlder() {
        if (loadingOlderRef.current || noMoreOlderRef.current) return;
        if (allCandlesRef.current.length === 0) return;
        loadingOlderRef.current = true;
        try {
          const earliestSec = allCandlesRef.current[0].time;
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
          const merged = [...filtered, ...allCandlesRef.current];
          allCandlesRef.current = merged;
          candleSeries.setData(merged);
          volumeSeries.setData(
            merged.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? VOL_UP : VOL_DOWN }))
          );
        } catch {
          /* ignore */
        } finally {
          loadingOlderRef.current = false;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
        if (!range) return;
        const info = candleSeries.barsInLogicalRange(range);
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
      abort.abort();
      observer?.disconnect();
      chart?.remove();
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      currentCandleRef.current = null;
    };
  }, [symbol, timeframe]);

  // Live in-progress bar from the mark stream.
  useEffect(() => {
    let lastPrice = 0;
    const unsub = useStatsStore.subscribe((state) => {
      const mark = state.marks[symbol];
      if (!mark || mark === lastPrice || !candleSeriesRef.current) return;
      lastPrice = mark;

      const interval = TF_SECONDS[tfRef.current] ?? 60;
      const bucket = Math.floor(Date.now() / 1000 / interval) * interval;
      const cur = currentCandleRef.current;

      if (!cur || cur.time !== bucket) {
        const next: Candle = { time: bucket, open: mark, high: mark, low: mark, close: mark, markClose: mark, volume: 0 };
        currentCandleRef.current = next;
        candleSeriesRef.current.update(next);
        volumeSeriesRef.current?.update({ time: bucket, value: 0, color: VOL_UP });
        return;
      }
      cur.close = mark;
      if (mark > cur.high) cur.high = mark;
      if (mark < cur.low) cur.low = mark;
      candleSeriesRef.current.update({ ...cur });
    });
    return unsub;
  }, [symbol]);

  return (
    <div ref={chartAreaRef} className="relative h-full w-full">
      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-1/80">
          <span className="font-mono text-[11px] text-text-secondary/70">
            {status === "loading" && "Loading chart…"}
            {status === "empty" && `No Phoenix candles for ${symbol}`}
            {status === "error" && "Failed to load chart data"}
          </span>
        </div>
      )}
    </div>
  );
}
