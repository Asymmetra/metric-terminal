"use client";

import { useEffect, useState } from "react";
import { Liveline, type LivelinePoint, type LivelineSeries } from "liveline";
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

/** Muted amber for non-primary entry lines — distinct from the #0EA5E9 mark line. */
const ENTRY_LINE_COLOR = "rgba(245, 158, 11, 0.55)";

/** Flat baseline (~1pt/sec, capped) at `price` across [now-windowSecs, now]. */
function flatSeed(price: number, windowSecs: number, now: number): LivelinePoint[] {
  const step = Math.max(1, Math.round(windowSecs / 90));
  const out: LivelinePoint[] = [];
  for (let t = now - windowSecs; t < now; t += step) out.push({ time: t, value: price });
  return out;
}

export function LiveLineChart({
  symbol,
  entryLines,
}: {
  symbol: string;
  /**
   * Optional explicit entry lines (the game passes one per active bet). When
   * provided and non-empty, these REPLACE the position-derived entry line: the
   * last entry becomes the in-scale `referenceLine` and every other entry is
   * drawn as a flat liveline series. When omitted (terminal usage), the chart
   * keeps deriving a single entry line from the open position.
   */
  entryLines?: { value: number; label?: string }[];
}) {
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

  // Entry lines. Two modes:
  //   1. entryLines provided (game): the last entry is the in-scale referenceLine;
  //      every other entry is a flat liveline series (clean stroke, no fill — the
  //      multi-series path in liveline draws each series with fill=false and a
  //      per-series palette, and folds each flat value into the y-range via
  //      computeRange, so a constant series renders as a crisp horizontal line
  //      that stays in scale without momentum/fill artifacts). The primary mark
  //      line is included as the FIRST series since multi-series mode does not
  //      auto-include the `data`/`value` line.
  //   2. entryLines omitted (terminal): keep the prior behavior — derive a single
  //      referenceLine from the open position. No series → single-line render path
  //      with full momentum/fill/pulse, exactly as before.
  let referenceLine: { value: number; label?: string } | undefined;
  let series: LivelineSeries[] | undefined;

  if (entryLines && entryLines.length > 0) {
    const last = entryLines[entryLines.length - 1];
    referenceLine = { value: last.value, label: last.label };

    series = [
      {
        id: "price",
        data: points,
        value,
        color: "#0EA5E9",
      },
      ...entryLines.slice(0, -1).map((e, i) => ({
        id: `entry-${i}`,
        data: points.map((p) => ({ time: p.time, value: e.value })),
        value: e.value,
        color: ENTRY_LINE_COLOR,
        label: e.label,
      })),
    ];
  } else {
    // Entry line for an open position (liveline keeps the reference value in scale,
    // so this stays near price; liquidation is shown on the candle chart instead).
    const pos = positions.find(
      (p) => p.asset === symbol && (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0)
    );
    const entry = pos?.entryPrice ? Number(pos.entryPrice) : null;
    referenceLine =
      entry && entry > 0 ? { value: entry, label: `Entry $${formatPriceAuto(entry)}` } : undefined;
  }

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
        series={series}
        referenceLine={referenceLine}
        loading={points.length === 0 && typeof mark !== "number"}
        emptyText={`Waiting for ${symbol} feed…`}
        formatValue={fmt}
      />
    </div>
  );
}
