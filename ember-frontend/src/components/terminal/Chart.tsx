"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { api } from "@/lib/api";
import { wsClient } from "@/lib/ws";
import { COLORS } from "@/lib/constants";
import clsx from "clsx";

const TIMEFRAMES = [
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "1H", value: "1h" },
  { label: "4H", value: "4h" },
  { label: "1D", value: "1d" },
] as const;

export function Chart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const candleSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const currentCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number } | null>(null);
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const [activeTimeframe, setActiveTimeframe] = useState("1m");
  const [chartError, setChartError] = useState<string | null>(null);
  const [showMarkers, setShowMarkers] = useState(true);
  const { publicKey } = useWallet();
  const lastRefresh = useTraderStore((s) => s.lastRefresh);

  // WS candle handler — updates the last bar in real-time
  // Only process candles matching the active timeframe (WS only sends 1m)
  const activeTimeframeRef = useRef(activeTimeframe);
  activeTimeframeRef.current = activeTimeframe;

  const handleCandleUpdate = useCallback((data: any) => {
    if (!data?.candle || !candleSeriesRef.current) return;
    // Bug fix #2: WS only sends 1m candles — filter by active timeframe
    if (data.timeframe && data.timeframe !== activeTimeframeRef.current) return;
    const c = data.candle;
    // Bug fix #1: Backend sends ms timestamps, Lightweight Charts expects seconds
    const time = c.time > 1e12 ? Math.floor(c.time / 1000) : c.time;
    const candle = { time, open: c.open, high: c.high, low: c.low, close: c.close };
    currentCandleRef.current = candle;
    candleSeriesRef.current.update(candle);
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.update({
        time,
        value: c.volume || 0,
        color:
          c.close >= c.open
            ? "rgba(46,226,155,0.15)"
            : "rgba(242,59,78,0.15)",
      });
    }
  }, []);

  useEffect(() => {
    if (!chartAreaRef.current) return;

    setChartError(null);
    let chart: any;
    let observer: ResizeObserver | null = null;
    let unsubCandles: (() => void) | null = null;
    const abortController = new AbortController();

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
          vertLines: { color: "rgba(42,43,51,0.5)" },
          horzLines: { color: "rgba(42,43,51,0.5)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: "rgba(255,85,0,0.3)",
            width: 1,
            style: 2,
            labelBackgroundColor: COLORS.emberOrange,
          },
          horzLine: {
            color: "rgba(255,85,0,0.3)",
            width: 1,
            style: 2,
            labelBackgroundColor: COLORS.surfaceL2,
          },
        },
        rightPriceScale: {
          borderColor: COLORS.emberBorder,
          textColor: COLORS.textSecondary,
          entireTextOnly: true,
        },
        timeScale: {
          borderColor: COLORS.emberBorder,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
          barSpacing: 6,
          fixLeftEdge: false,
          fixRightEdge: true,
        },
        localization: {
          timeFormatter: (timestamp: number) => {
            const date = new Date(timestamp * 1000);
            return date.toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
          },
        },
        width: chartAreaRef.current.clientWidth,
        height: chartAreaRef.current.clientHeight,
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: COLORS.emberGreen,
        downColor: COLORS.emberRed,
        borderUpColor: COLORS.emberGreen,
        borderDownColor: COLORS.emberRed,
        wickUpColor: COLORS.emberGreen,
        wickDownColor: COLORS.emberRed,
      });
      candleSeriesRef.current = candleSeries;

      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });
      volumeSeriesRef.current = volumeSeries;

      // Fetch historical candles from REST
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/candles/${selectedSymbol}?timeframe=${activeTimeframe}&limit=300`,
          { signal: abortController.signal }
        );
        if (res.ok) {
          const candles = await res.json();
          // Bug fix #1: Backend sends ms timestamps, Lightweight Charts expects seconds
          const normalized = candles.map((c: any) => ({
            ...c,
            time: c.time > 1e12 ? Math.floor(c.time / 1000) : c.time,
          }));
          candleSeries.setData(normalized);
          setChartError(null);

          // Seed the current candle ref from the last historical candle
          if (normalized.length > 0) {
            const last = normalized[normalized.length - 1];
            currentCandleRef.current = {
              time: last.time,
              open: last.open,
              high: last.high,
              low: last.low,
              close: last.close,
            };
          }

          const volumeData = normalized.map((c: any) => ({
            time: c.time,
            value: c.volume || 0,
            color:
              c.close >= c.open
                ? "rgba(46,226,155,0.15)"
                : "rgba(242,59,78,0.15)",
          }));
          volumeSeries.setData(volumeData);
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.error("Failed to fetch candles:", e);
        setChartError("Failed to load chart data");
      }

      // Subscribe to real-time candle updates via WebSocket
      unsubCandles = wsClient.subscribe(
        "candles",
        selectedSymbol,
        handleCandleUpdate
      );

      // Handle resize
      observer = new ResizeObserver(() => {
        if (chartAreaRef.current) {
          chart.applyOptions({
            width: chartAreaRef.current.clientWidth,
            height: chartAreaRef.current.clientHeight,
          });
        }
      });
      if (chartAreaRef.current) {
        observer.observe(chartAreaRef.current);
      }
    }

    initChart();

    return () => {
      abortController.abort();
      unsubCandles?.();
      observer?.disconnect();
      chart?.remove();
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      currentCandleRef.current = null;
    };
  }, [selectedSymbol, activeTimeframe, handleCandleUpdate]);

  // Real-time price tick: update current candle's close from mark_price,
  // and roll to a new candle when the time bucket changes.
  // Bridges the gap between infrequent WS candle events and the
  // continuously-updating mark price from the stats channel.
  useEffect(() => {
    const tfSeconds: Record<string, number> = {
      "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
    };
    let lastPrice = 0;
    const unsub = useStatsStore.subscribe((state) => {
      const markPrice = state.stats?.mark_price;
      if (!markPrice || markPrice === lastPrice || !candleSeriesRef.current) return;
      lastPrice = markPrice;

      const interval = tfSeconds[activeTimeframeRef.current] || 60;
      const bucketTime = Math.floor(Date.now() / 1000 / interval) * interval;
      const current = currentCandleRef.current;

      if (!current || current.time !== bucketTime) {
        // Either no candle yet, or the time bucket just rolled over.
        // Start a fresh bar anchored at markPrice instead of stretching
        // the previous one — lightweight-charts treats series.update()
        // with a new timestamp as an append.
        currentCandleRef.current = {
          time: bucketTime as any,
          open: markPrice,
          high: markPrice,
          low: markPrice,
          close: markPrice,
        };
        candleSeriesRef.current.update(currentCandleRef.current);
        if (volumeSeriesRef.current) {
          volumeSeriesRef.current.update({
            time: bucketTime as any,
            value: 0,
            color: "rgba(46,226,155,0.15)",
          });
        }
        return;
      }
      current.close = markPrice;
      if (markPrice > current.high) current.high = markPrice;
      if (markPrice < current.low) current.low = markPrice;
      candleSeriesRef.current.update({ ...current });
    });
    return unsub;
  }, [selectedSymbol, activeTimeframe]);

  // Trade markers: overlay the user's historical fills on this market's chart.
  // Encodes each fill along four dimensions so a glance is enough:
  //   • color          — green = action on the long side, red = short side
  //   • brightness     — full saturation = open/add, dimmed = close/reduce
  //   • arrow direction — matches the direction of the trade (buy up, sell down)
  //   • text prefix    — "Long" / "Short" / "Close" / "Cover" / "+" / "−"
  // `baseLotsBefore` and `baseLotsAfter` (signed) tell us whether the fill
  // grew the position (open/add) or shrank it (close/reduce).
  useEffect(() => {
    if (!publicKey || !candleSeriesRef.current || !showMarkers) {
      if (candleSeriesRef.current) candleSeriesRef.current.setMarkers([]);
      return;
    }

    let cancelled = false;
    api.getTraderTrades(publicKey.toBase58(), { limit: 200 })
      .then((result) => {
        if (cancelled || !candleSeriesRef.current) return;
        const trades = result.trades || [];
        const markers = trades
          .filter((t: any) => t.marketSymbol === selectedSymbol)
          .map((t: any) => {
            const ts = new Date(t.timestamp);
            const time = Math.floor(ts.getTime() / 1000);
            const before = parseFloat(t.baseLotsBefore || "0");
            const after = parseFloat(t.baseLotsAfter || "0");
            const delta = parseFloat(t.baseLotsDelta || "0");
            const absDelta = Math.abs(delta);
            const absBefore = Math.abs(before);
            const absAfter = Math.abs(after);
            const isBuy = delta > 0;

            // Classify the fill. Default to open-long if data is missing,
            // so we never render an empty/NaN label again.
            let verb: string;
            let longSide: boolean;
            let opening: boolean;
            if (absBefore === 0 && absAfter > 0) {
              opening = true;
              longSide = after > 0;
              verb = longSide ? "Long" : "Short";
            } else if (absAfter === 0 && absBefore > 0) {
              opening = false;
              longSide = before > 0;
              verb = longSide ? "Close" : "Cover";
            } else if (absAfter > absBefore) {
              // Adding to an existing position in the same direction.
              opening = true;
              longSide = (after || delta) > 0;
              verb = "+";
            } else {
              // Partial reduce in the same direction.
              opening = false;
              longSide = before > 0;
              verb = "−";
            }

            // Color by side, dim on close/reduce so the eye separates
            // "taking on risk" from "bleeding it off".
            const color = longSide
              ? opening ? COLORS.emberGreen : "rgba(46,226,155,0.55)"
              : opening ? COLORS.emberRed : "rgba(242,59,78,0.55)";

            return {
              time,
              position: isBuy ? ("belowBar" as const) : ("aboveBar" as const),
              color,
              shape: isBuy ? ("arrowUp" as const) : ("arrowDown" as const),
              text: `${verb} ${absDelta.toFixed(2)}`,
            };
          })
          .sort((a: any, b: any) => a.time - b.time);
        candleSeriesRef.current.setMarkers(markers);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [publicKey, selectedSymbol, activeTimeframe, showMarkers, lastRefresh]);

  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-ember-border/50 bg-surface-l1 px-2 py-1">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setActiveTimeframe(tf.value)}
            className={clsx(
              "px-2 py-0.5 font-mono text-[10px] transition-colors",
              activeTimeframe === tf.value
                ? "bg-surface-l2 text-ember-orange"
                : "text-text-secondary/60 hover:text-text-secondary"
            )}
          >
            {tf.label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          {publicKey && (
            <button
              onClick={() => setShowMarkers((v) => !v)}
              className={clsx(
                "px-2 py-0.5 font-mono text-[10px] transition-colors",
                showMarkers
                  ? "bg-surface-l2 text-ember-orange"
                  : "text-text-secondary/60 hover:text-text-secondary"
              )}
              title={showMarkers ? "Hide trade markers" : "Show trade markers"}
            >
              Trades
            </button>
          )}
          <span className="font-mono text-[10px] text-text-secondary/60">
            {selectedSymbol}-PERP
          </span>
        </div>
      </div>

      {/* Chart area */}
      <div ref={chartAreaRef} className="relative flex-1">
        {chartError && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-l1/80">
            <div className="flex flex-col items-center gap-2">
              <span className="font-mono text-[11px] text-ember-red">{chartError}</span>
              <button
                onClick={() => setChartError(null)}
                className="font-mono text-[10px] text-text-secondary/60 hover:text-text-secondary"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
