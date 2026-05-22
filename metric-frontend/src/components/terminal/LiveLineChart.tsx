"use client";

import { useEffect, useRef, useState } from "react";
import { Liveline, type LivelinePoint } from "liveline";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { fetchCandles } from "@/lib/phoenix-candles";
import { formatPriceAuto } from "@/lib/format";

/**
 * Live-scrolling line chart powered by `liveline` — the fast, degen, always-
 * streaming view. Not candle-bucketed: it appends one point per tick at
 * wall-clock time and feeds the latest mark as `value`; liveline scrolls by
 * wall-clock and lerps the tip at 60fps.
 *
 * Default window is 1 minute. Phoenix's finest candle is 1m, so a 60s window has
 * no real sub-minute history — we seed a *dense* synthetic backfill (~1pt/sec)
 * interpolated from the most recent mark-closes so the line is full-width from
 * the first frame (no blank start / mid-canvas dot), then real ticks stream in.
 */

const WINDOWS = [
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
  { label: "1H", secs: 3600 },
];

const fmt = (v: number) => `$${formatPriceAuto(v)}`;

/**
 * Seed a flat baseline (~1pt/sec) at `price` across [now-windowSecs, now].
 * Phoenix has no sub-minute history, so a flat line at the current price is the
 * honest placeholder: the chart is full-width instantly (no blank / mid-canvas
 * dot), then real live ticks animate the right edge and scroll the baseline off
 * within one window-duration. (Interpolating a "shape" from sparse 1m closes
 * just draws fake straight-line ramps, so we don't.)
 */
function flatSeed(price: number, windowSecs: number, now: number): LivelinePoint[] {
  const step = Math.max(1, Math.round(windowSecs / 90));
  const out: LivelinePoint[] = [];
  for (let t = now - windowSecs; t < now; t += step) out.push({ time: t, value: price });
  return out;
}

export function LiveLineChart({ symbol }: { symbol: string }) {
  const mark = useStatsStore((s) => s.marks[symbol]);
  const positions = useTraderStore((s) => s.positions);

  const [points, setPoints] = useState<LivelinePoint[]>([]);
  const [windowSecs, setWindowSecs] = useState(60);
  const windowRef = useRef(windowSecs);
  windowRef.current = windowSecs;

  // Flat baseline seed so the window is full-width immediately. Re-runs on
  // symbol or window change (so 5m/15m/1h fill too).
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const apply = (price: number) => {
      if (!cancelled && price > 0) setPoints(flatSeed(price, windowRef.current, Date.now() / 1000));
    };
    const live = useStatsStore.getState().marks[symbol];
    if (typeof live === "number") {
      apply(live); // instant seed from the live mark when we already have it
    } else {
      // otherwise grab the last Phoenix close to baseline against
      fetchCandles(symbol, "1m", { limit: 1, signal: ctrl.signal })
        .then((c) => apply(c[c.length - 1]?.markClose ?? 0))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [symbol, windowSecs]);

  // Heartbeat: append the latest mark at wall-clock time every 500ms (plus
  // immediately on each change). This guarantees the line always reaches "now"
  // even if the feed pauses — otherwise liveline scrolls by wall-clock and the
  // stale data drifts left, leaving empty space on the right ("falling off").
  const markRef = useRef(mark);
  markRef.current = mark;
  useEffect(() => {
    const append = () => {
      const v = markRef.current;
      if (typeof v !== "number") return;
      const now = Date.now() / 1000;
      setPoints((prev) => {
        const next = [...prev, { time: now, value: v }];
        const cutoff = now - (windowRef.current + 30);
        const trimmed = next.filter((p) => p.time >= cutoff);
        return trimmed.length > 5000 ? trimmed.slice(-5000) : trimmed;
      });
    };
    append();
    const id = setInterval(append, 500);
    return () => clearInterval(id);
  }, [symbol]);

  const value = mark ?? points[points.length - 1]?.value ?? 0;

  // Entry line for an open position (liveline keeps the reference value in scale,
  // so this stays near price; liquidation is shown on the candle chart instead).
  const pos = positions.find(
    (p) => p.asset === symbol && (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0)
  );
  const entry = pos?.entryPrice ? Number(pos.entryPrice) : null;
  const referenceLine =
    entry && entry > 0 ? { value: entry, label: `Entry $${formatPriceAuto(entry)}` } : undefined;

  // Inset the canvas 6px at the bottom so the line never kisses the very edge
  // on a dip (liveline maps the data min to the canvas floor; its `padding`
  // prop only positions axis labels, not the data range).
  return (
    <div className="absolute inset-x-0 top-0 bottom-[6px]">
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
