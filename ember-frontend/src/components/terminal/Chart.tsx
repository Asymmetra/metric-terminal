"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useMarketStore } from "@/stores/marketStore";
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
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const [activeTimeframe, setActiveTimeframe] = useState("1m");

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
    candleSeriesRef.current.update({
      time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
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

    let chart: any;
    let observer: ResizeObserver | null = null;
    let unsubCandles: (() => void) | null = null;

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
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/candles/${selectedSymbol}?timeframe=${activeTimeframe}&limit=300`
        );
        if (res.ok) {
          const candles = await res.json();
          // Bug fix #1: Backend sends ms timestamps, Lightweight Charts expects seconds
          const normalized = candles.map((c: any) => ({
            ...c,
            time: c.time > 1e12 ? Math.floor(c.time / 1000) : c.time,
          }));
          candleSeries.setData(normalized);

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
        console.error("Failed to fetch candles:", e);
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
      unsubCandles?.();
      observer?.disconnect();
      chart?.remove();
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [selectedSymbol, activeTimeframe, handleCandleUpdate]);

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
          <span className="font-mono text-[10px] text-text-secondary/60">
            {selectedSymbol}-PERP
          </span>
        </div>
      </div>

      {/* Chart area */}
      <div ref={chartAreaRef} className="flex-1" />
    </div>
  );
}
