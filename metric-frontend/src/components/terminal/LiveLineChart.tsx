"use client";

import { useEffect, useState } from "react";
import { Liveline, type LivelinePoint } from "liveline";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { priceHistory } from "@/lib/price-history";
import { formatPriceAuto } from "@/lib/format";

/**
 * Live-scrolling line chart powered by `liveline` — the fast, degen, always-
 * streaming view. Not candle-bucketed: it appends one point per tick at
 * wall-clock time and feeds the latest mark as `value`; liveline scrolls by
 * wall-clock and lerps the tip at 60fps.
 *
 * Points come from the session `priceHistory` buffer (fed continuously by the
 * market-data feed, independent of which chart is showing). So:
 *   - switching the window (1m/5m/15m/1H) just re-windows the same buffer —
 *     no reset of accumulated history;
 *   - time spent on the candle view / other pages still fills the buffer, so
 *     returning shows the gap, not a cold start.
 *
 * Cold start (empty buffer): a short flat baseline at the current mark keeps the
 * line full-width instead of blank until real ticks accumulate. Phoenix has no
 * sub-minute history to backfill, so a flat baseline is the honest placeholder.
 */

const WINDOWS = [
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
  { label: "1H", secs: 3600 },
];

const fmt = (v: number) => `$${formatPriceAuto(v)}`;

/** Flat baseline (~1pt/sec, capped) at `price` across [now-windowSecs, now]. */
function flatSeed(price: number, windowSecs: number, now: number): LivelinePoint[] {
  const step = Math.max(1, Math.round(windowSecs / 90));
  const out: LivelinePoint[] = [];
  for (let t = now - windowSecs; t < now; t += step) out.push({ time: t, value: price });
  return out;
}

export function LiveLineChart({ symbol }: { symbol: string }) {
  const mark = useStatsStore((s) => s.marks[symbol]);
  const positions = useTraderStore((s) => s.positions);

  const [windowSecs, setWindowSecs] = useState(60);
  // Tick state forces a re-derive of `points` on each buffer change + 500ms beat.
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => (n + 1) % 1_000_000);

  // Re-render when the buffer gets new data and on a steady 500ms beat (so the
  // trailing edge keeps advancing toward "now" even between buffer writes).
  useEffect(() => {
    const unsub = priceHistory.subscribe(bump);
    const id = setInterval(bump, 500);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  // Derive the windowed view from the session buffer each render.
  const now = Date.now() / 1000;
  const buffered = priceHistory.getSince(symbol, now - windowSecs);
  let points: LivelinePoint[] = buffered.map((p) => ({ time: p.t, value: p.v }));

  // Cold start: nothing buffered yet → flat baseline at the live mark so the
  // chart is full-width immediately rather than blank.
  if (points.length < 2 && typeof mark === "number" && mark > 0) {
    points = flatSeed(mark, windowSecs, now);
  }

  const value = mark ?? points[points.length - 1]?.value ?? 0;

  // Entry line for an open position (liveline keeps the reference value in scale,
  // so this stays near price; liquidation is shown on the candle chart instead).
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
        degen={{ downMomentum: true }}
        momentum
        valueMomentumColor
        fill
        pulse
        showValue
        grid
        lineWidth={2}
        referenceLine={referenceLine}
        loading={points.length === 0 && typeof mark !== "number"}
        emptyText={`Waiting for ${symbol} feed…`}
        formatValue={fmt}
      />
    </div>
  );
}
