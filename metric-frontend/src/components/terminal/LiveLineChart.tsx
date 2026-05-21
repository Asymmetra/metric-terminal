"use client";

import { useEffect, useRef, useState } from "react";
import { Liveline, type LivelinePoint } from "liveline";
import { useStatsStore } from "@/stores/statsStore";
import { useOrderbookStore } from "@/stores/orderbookStore";
import { useTraderStore } from "@/stores/traderStore";
import { usePythPrice } from "@/lib/pyth";
import { fetchCandles, toMarkLine } from "@/lib/phoenix-candles";
import { formatPriceAuto } from "@/lib/format";

/**
 * Live-scrolling line chart powered by `liveline`.
 *
 * A true live stream (not candle-bucketed): appends one point per tick at
 * wall-clock time and feeds the latest price as `value`; liveline scrolls by
 * wall-clock and lerps the tip at 60fps. A low lerpSpeed makes the glide last
 * ~as long as the gap between ticks, so the line is almost always moving.
 *
 * The live value comes from the selected source:
 *   - "mark" (default): Phoenix-anchored canonical mark (statsStore)
 *   - "mid":  Phoenix order-book mid (orderbookStore)
 *   - "pyth": Pyth oracle via Hermes SSE (falls back to mark)
 */

export type LineSource = "mark" | "mid" | "pyth";

const WINDOWS = [
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
];

const fmt = (v: number) => `$${formatPriceAuto(v)}`;

export function LiveLineChart({ symbol, source }: { symbol: string; source: LineSource }) {
  const mark = useStatsStore((s) => s.marks[symbol]);
  const mid = useOrderbookStore((s) =>
    s.snapshot && s.snapshot.symbol === symbol ? s.snapshot.mid : undefined
  );
  const pyth = usePythPrice(symbol, source === "pyth");
  const positions = useTraderStore((s) => s.positions);

  // Resolve the live value from the chosen source, falling back to the mark.
  const live =
    source === "pyth" ? pyth ?? mark : source === "mid" ? mid ?? mark : mark;

  const [points, setPoints] = useState<LivelinePoint[]>([]);
  const [windowSecs, setWindowSecs] = useState(60);
  const windowRef = useRef(windowSecs);
  windowRef.current = windowSecs;

  // Seed with a little recent Phoenix history so the chart isn't blank on load.
  // (History stays Phoenix markClose regardless of live source.)
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

  // Append each new value at wall-clock time; trim to the visible window + slack.
  useEffect(() => {
    if (typeof live !== "number") return;
    const now = Date.now() / 1000;
    setPoints((prev) => {
      const next = [...prev, { time: now, value: live }];
      const cutoff = now - (windowRef.current + 30);
      const trimmed = next.filter((p) => p.time >= cutoff);
      return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed;
    });
  }, [live, symbol]);

  const value = live ?? points[points.length - 1]?.value ?? 0;

  // Entry reference line when an open position exists for this symbol.
  const pos = positions.find(
    (p) => p.asset === symbol && (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0)
  );
  const entry = pos?.entryPrice ? Number(pos.entryPrice) : null;
  const referenceLine =
    entry && entry > 0 ? { value: entry, label: `Entry $${formatPriceAuto(entry)}` } : undefined;

  return (
    <div className="absolute inset-0">
      <Liveline
        data={points}
        value={value}
        color="#0EA5E9"
        theme="dark"
        window={windowSecs}
        windows={WINDOWS}
        windowStyle="rounded"
        onWindowChange={setWindowSecs}
        lerpSpeed={0.03}
        exaggerate
        degen={{ downMomentum: true }}
        momentum
        valueMomentumColor
        fill
        pulse
        showValue
        grid
        lineWidth={2}
        referenceLine={referenceLine}
        loading={points.length === 0 && typeof live !== "number"}
        emptyText={`Waiting for ${symbol} feed…`}
        formatValue={fmt}
      />
    </div>
  );
}
