"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";
import { imperial } from "@/lib/imperial";
import type { CostBreakdown, MarkPriceRow, RouteResponse, VenueTag } from "@/lib/imperial/types";
import { formatPriceAuto } from "@/lib/format";

/**
 * Per-venue quotes for the selected symbol — the "where would Auto trade this"
 * view. For each venue we show its live quote + how recent it is (Imperial's
 * `fetchedAtUnixMs`), and from `/route`: round-trip cost, the open+close fee and
 * slippage estimate, and max leverage. The venue Auto would route to is flagged.
 * Both `/mark-prices` and `/route` are polled every 5s so this works regardless
 * of WS health.
 */

const VENUES: { tag: VenueTag; label: string; markKey: "phoenix" | "jupiter" | "flash" | "gmtrade" }[] = [
  { tag: "phoenix", label: "Phoenix", markKey: "phoenix" },
  { tag: "jupiter", label: "Jupiter", markKey: "jupiter" },
  { tag: "flash_trade", label: "Flash", markKey: "flash" },
  { tag: "gmtrade", label: "GMTrade", markKey: "gmtrade" },
];

function ago(ms: number | undefined, now: number): string {
  if (!ms) return "—";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

interface VenueCost {
  cost?: number;
  cb?: CostBreakdown;
  maxLev?: number;
  filtered?: string | null;
}

export function VenueQuotes() {
  const symbol = useMarketStore((s) => s.selectedSymbol);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [row, setRow] = useState<MarkPriceRow | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [r, m] = await Promise.all([
        imperial.getRoute({ asset: symbol, side: "long", notional: 100, desiredLeverage: 2 }).catch(() => null),
        imperial.getMarkPrices().catch(() => null),
      ]);
      if (cancelled) return;
      if (r) setRoute(r);
      if (m) setRow(m.rows.find((x) => x.symbol === symbol) ?? null);
    };
    setRoute(null);
    setRow(null);
    void load();
    const id = setInterval(load, 5_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(tick);
    };
  }, [symbol]);

  const cand: Record<string, VenueCost> = {};
  for (const c of route?.candidates ?? []) {
    cand[c.venue] = { cost: c.expectedCostUsd, cb: c.costBreakdown, maxLev: c.maxLeverage, filtered: c.filteredReason };
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-[1fr_auto] gap-3 border-b border-metric-border/40 px-3 py-1 font-mono text-[9px] uppercase text-text-secondary/40">
        <span>Venue</span>
        <span className="text-right">Quote · age</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {VENUES.map((v) => {
          const mp = row?.[v.markKey] ?? null;
          const c = cand[v.tag];
          const isBest = route?.venue === v.tag;
          const fee = c?.cb ? (Number(c.cb.openFee) || 0) + (Number(c.cb.closeFee) || 0) : null;
          const slip = c?.cb ? (Number(c.cb.openSlip) || 0) + (Number(c.cb.closeSlip) || 0) : null;
          return (
            <div key={v.tag} className={clsx("border-b border-metric-border/30 px-3 py-2", isBest && "bg-metric-primary/10")}>
              <div className="flex items-center justify-between font-mono text-[12px]">
                <span className="flex items-center gap-2">
                  {isBest && (
                    <span className="rounded-sm bg-metric-primary/20 px-1 text-[8px] uppercase tracking-wider text-metric-primary">
                      best
                    </span>
                  )}
                  <span className={isBest ? "text-metric-primary" : "text-text-primary"}>{v.label}</span>
                </span>
                <span className="text-right text-text-secondary">
                  {mp?.price != null ? `$${formatPriceAuto(mp.price)}` : "—"}
                  <span className="ml-2 text-[10px] text-text-secondary/40">{ago(mp?.fetchedAtUnixMs, now)}</span>
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between font-mono text-[9.5px] text-text-secondary/50">
                <span>
                  {c?.filtered ? (
                    <span className="text-metric-sell/70">unavailable for size</span>
                  ) : (
                    <>
                      fee ${fee != null ? fee.toFixed(3) : "—"} · slip ${slip != null ? slip.toFixed(3) : "—"} · max{" "}
                      {c?.maxLev ? `${Math.round(c.maxLev)}×` : "—"}
                    </>
                  )}
                </span>
                <span>{c?.filtered ? "" : `RT $${c?.cost != null ? c.cost.toFixed(4) : "—"}`}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-metric-border px-3 py-1.5 font-mono text-[9px] text-text-secondary/50">
        {route ? `Auto → ${route.venue} · ${route.reason}` : "Resolving best route…"}
      </div>
    </div>
  );
}
