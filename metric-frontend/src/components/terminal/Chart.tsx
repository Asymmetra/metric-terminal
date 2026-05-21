"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { COLORS } from "@/lib/constants";
import {
  fetchCandles,
  TIMEFRAMES,
  type Candle,
  type Timeframe,
} from "@/lib/phoenix-candles";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Series = any;

const UP = COLORS.emberGreen; // metric-buy (cyan)
const DOWN = COLORS.emberRed; // metric-sell (orange)
const LINE = COLORS.emberOrange; // metric-primary (sky)
const VOL_UP = "rgba(34,211,238,0.15)";
const VOL_DOWN = "rgba(249,115,22,0.15)";

type ChartType = "candles" | "line";

export function Chart() {
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const priceSeriesRef = useRef<Series>(null);
  const volumeSeriesRef = useRef<Series>(null);
  const currentCandleRef = useRef<Candle | null>(null);
  const allCandlesRef = useRef<Candle[]>([]);
  const loadingOlderRef = useRef(false);
  const noMoreOlderRef = useRef(false);

  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("1m");
  const activeTfRef = useRef<Timeframe>(activeTimeframe);
  activeTfRef.current = activeTimeframe;
  const [chartType, setChartType] = useState<ChartType>("candles");
  const chartTypeRef = useRef<ChartType>(chartType);
  chartTypeRef.current = chartType;
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");

  // ── chart lifecycle: rebuild on symbol/timeframe/type change ──
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

      // Price series: candlesticks or a line of closes — same source data.
      const isLine = chartTypeRef.current === "line";
      const priceSeries = isLine
        ? chart.addLineSeries({ color: LINE, lineWidth: 2, priceLineVisible: true, lastValueVisible: true })
        : chart.addCandlestickSeries({
            upColor: UP,
            downColor: DOWN,
            borderUpColor: UP,
            borderDownColor: DOWN,
            wickUpColor: UP,
            wickDownColor: DOWN,
          });
      priceSeriesRef.current = priceSeries;

      // Shape a candle for whichever series is active. The line is mark-based
      // (markClose) so its history matches the live mark that drives the tip.
      const toPricePoint = (c: Candle) => (isLine ? { time: c.time, value: c.markClose } : c);

      const volumeSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "" });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      volumeSeriesRef.current = volumeSeries;

      allCandlesRef.current = [];
      loadingOlderRef.current = false;
      noMoreOlderRef.current = false;

      try {
        const candles = await fetchCandles(selectedSymbol, activeTfRef.current, { limit: 300, signal: abort.signal });
        if (candles.length === 0) {
          setStatus("empty");
          return;
        }
        priceSeries.setData(candles.map(toPricePoint));
        volumeSeries.setData(
          candles.map((c) => ({
            time: c.time,
            value: c.volume,
            color: c.close >= c.open ? VOL_UP : VOL_DOWN,
          }))
        );
        allCandlesRef.current = candles;
        currentCandleRef.current = candles[candles.length - 1];
        setStatus("ready");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.error("Failed to load candles:", e);
        setStatus("error");
      }

      // Scroll-back pagination.
      async function loadOlder() {
        if (loadingOlderRef.current || noMoreOlderRef.current) return;
        if (allCandlesRef.current.length === 0) return;
        loadingOlderRef.current = true;
        try {
          const earliestSec = allCandlesRef.current[0].time;
          const older = await fetchCandles(selectedSymbol, activeTfRef.current, {
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
          priceSeries.setData(merged.map(toPricePoint));
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
        const info = priceSeries.barsInLogicalRange(range);
        if (info && info.barsBefore < 15) void loadOlder();
      });

      observer = new ResizeObserver(() => {
        if (chartAreaRef.current) {
          chart.applyOptions({
            width: chartAreaRef.current.clientWidth,
            height: chartAreaRef.current.clientHeight,
          });
        }
      });
      observer.observe(chartAreaRef.current);
    }

    void initChart();

    return () => {
      abort.abort();
      observer?.disconnect();
      chart?.remove();
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      currentCandleRef.current = null;
    };
  }, [selectedSymbol, activeTimeframe, chartType]);

  // ── live bar: drive the in-progress candle from the mark-price stream ──
  useEffect(() => {
    const tfSeconds: Record<Timeframe, number> = {
      "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
    };
    let lastPrice = 0;
    const unsub = useStatsStore.subscribe((state) => {
      const mark = state.marks[selectedSymbol];
      if (!mark || mark === lastPrice || !priceSeriesRef.current) return;
      lastPrice = mark;

      const interval = tfSeconds[activeTfRef.current] ?? 60;
      const bucket = Math.floor(Date.now() / 1000 / interval) * interval;
      const cur = currentCandleRef.current;
      const isLine = chartTypeRef.current === "line";

      if (!cur || cur.time !== bucket) {
        const next: Candle = { time: bucket, open: mark, high: mark, low: mark, close: mark, markClose: mark, volume: 0 };
        currentCandleRef.current = next;
        priceSeriesRef.current.update(isLine ? { time: bucket, value: mark } : next);
        volumeSeriesRef.current?.update({ time: bucket, value: 0, color: VOL_UP });
        return;
      }
      cur.close = mark;
      if (mark > cur.high) cur.high = mark;
      if (mark < cur.low) cur.low = mark;
      priceSeriesRef.current.update(isLine ? { time: cur.time, value: mark } : { ...cur });
    });
    return unsub;
  }, [selectedSymbol]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-metric-border/50 bg-surface-1 px-2 py-1">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setActiveTimeframe(tf.value)}
            className={clsx(
              "px-2 py-0.5 font-mono text-[10px] transition-colors",
              activeTimeframe === tf.value
                ? "bg-surface-2 text-metric-primary"
                : "text-text-secondary/60 hover:text-text-secondary"
            )}
          >
            {tf.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1">
            {(["candles", "line"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setChartType(t)}
                title={t === "candles" ? "Candlestick chart" : "Line chart"}
                className={clsx(
                  "px-2 py-0.5 font-mono text-[10px] capitalize transition-colors",
                  chartType === t
                    ? "bg-surface-2 text-metric-primary"
                    : "text-text-secondary/60 hover:text-text-secondary"
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="font-mono text-[10px] text-text-secondary/60">
            {selectedSymbol}/USD · Phoenix
          </span>
        </div>
      </div>

      <div ref={chartAreaRef} className="relative flex-1">
        {status !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-1/80">
            <span className="font-mono text-[11px] text-text-secondary/70">
              {status === "loading" && "Loading chart…"}
              {status === "empty" && `No Phoenix candles for ${selectedSymbol}`}
              {status === "error" && "Failed to load chart data"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
