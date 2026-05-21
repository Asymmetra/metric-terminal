"use client";

import { useEffect, useRef, useState } from "react";
import { Liveline, type LivelinePoint } from "liveline";
import { useStatsStore } from "@/stores/statsStore";
import { fetchCandles, toMarkLine } from "@/lib/phoenix-candles";
import { formatPriceAuto } from "@/lib/format";

/**
 * Live-scrolling line chart powered by `liveline`.
 *
 * Unlike the candle chart, this is NOT bucketed into timeframes — it's a true
 * live stream. We append one point per mark tick at real wall-clock time and
 * pass the latest mark as `value`; liveline scrolls by wall-clock and lerps
 * the tip toward `value` at 60fps, so Imperial's ~1 mark/sec looks continuous.
 *
 * Source of truth is the venue-stable canonical mark in statsStore (anchored
 * to Phoenix), so the line tracks one consistent price instead of flip-flopping
 * between venues.
 */

const WINDOWS = [
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
];

const fmt = (v: number) => `$${formatPriceAuto(v)}`;

export function LiveLineChart({ symbol }: { symbol: string }) {
  const liveMark = useStatsStore((s) => s.marks[symbol]);
  const [points, setPoints] = useState<LivelinePoint[]>([]);
  const [windowSecs, setWindowSecs] = useState(60);
  const windowRef = useRef(windowSecs);
  windowRef.current = windowSecs;

  // Seed with a little recent Phoenix history so the chart isn't blank on load.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setPoints([]);
    fetchCandles(symbol, "1m", { limit: 30, signal: ctrl.signal })
      .then((candles) => {
        if (!cancelled) setPoints(toMarkLine(candles));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [symbol]);

  // Append each new mark at wall-clock time; trim to the visible window + slack.
  useEffect(() => {
    if (typeof liveMark !== "number") return;
    const now = Date.now() / 1000;
    setPoints((prev) => {
      const next = [...prev, { time: now, value: liveMark }];
      const cutoff = now - (windowRef.current + 30);
      const trimmed = next.filter((p) => p.time >= cutoff);
      // Hard cap so a long session can't grow unbounded.
      return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed;
    });
  }, [liveMark, symbol]);

  const value = liveMark ?? points[points.length - 1]?.value ?? 0;

  return (
    <div className="h-full w-full">
      <Liveline
        data={points}
        value={value}
        color="#0EA5E9"
        theme="dark"
        window={windowSecs}
        windows={WINDOWS}
        onWindowChange={setWindowSecs}
        lerpSpeed={0.08}
        momentum
        fill
        pulse
        showValue
        grid
        lineWidth={2}
        loading={points.length === 0 && typeof liveMark !== "number"}
        emptyText={`Waiting for ${symbol} mark feed…`}
        formatValue={fmt}
      />
    </div>
  );
}
