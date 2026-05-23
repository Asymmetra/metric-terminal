"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { imperial } from "@/lib/imperial";
import type { RouteResponse, VenueTag } from "@/lib/imperial/types";
import { formatPriceAuto } from "@/lib/format";

/**
 * Per-venue quotes for the selected symbol — the "where would Auto trade this"
 * view. Live mark per venue from `marksByVenue`, and Imperial's `/route` (polled)
 * gives the recommended venue + per-venue round-trip cost so the user can see why
 * Auto picks what it picks.
 */

const VENUES: { tag: VenueTag; label: string; markKeys: string[] }[] = [
  { tag: "phoenix", label: "Phoenix", markKeys: ["phoenix"] },
  { tag: "jupiter", label: "Jupiter", markKeys: ["jupiter"] },
  { tag: "flash_trade", label: "Flash", markKeys: ["flash", "flash_trade"] },
  { tag: "gmtrade", label: "GMTrade", markKeys: ["gmtrade"] },
];

export function VenueQuotes() {
  const symbol = useMarketStore((s) => s.selectedSymbol);
  const marksByVenue = useStatsStore((s) => s.marksByVenue[symbol]);
  const [route, setRoute] = useState<RouteResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      imperial
        .getRoute({ asset: symbol, side: "long", notional: 100, desiredLeverage: 2 })
        .then((r) => !cancelled && setRoute(r))
        .catch(() => {});
    setRoute(null);
    void load();
    const id = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  const byVenue: Record<string, { cost?: number; filtered?: string | null }> = {};
  for (const c of route?.candidates ?? []) byVenue[c.venue] = { cost: c.expectedCostUsd, filtered: c.filteredReason };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-[1fr_auto_auto] gap-4 border-b border-metric-border/40 px-3 py-1 font-mono text-[9px] uppercase text-text-secondary/40">
        <span>Venue</span>
        <span className="text-right">Quote</span>
        <span className="text-right">Cost (RT)</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {VENUES.map((v) => {
          const mark = v.markKeys.map((k) => marksByVenue?.[k]).find((x) => typeof x === "number");
          const cb = byVenue[v.tag];
          const isBest = route?.venue === v.tag;
          return (
            <div
              key={v.tag}
              className={clsx(
                "grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-metric-border/30 px-3 py-2 font-mono text-[12px]",
                isBest && "bg-metric-primary/10"
              )}
            >
              <span className="flex items-center gap-2">
                {isBest && (
                  <span className="rounded-sm bg-metric-primary/20 px-1 text-[8px] uppercase tracking-wider text-metric-primary">
                    best
                  </span>
                )}
                <span className={isBest ? "text-metric-primary" : "text-text-primary"}>{v.label}</span>
              </span>
              <span className="text-right text-text-secondary">{mark != null ? `$${formatPriceAuto(mark)}` : "—"}</span>
              <span className="text-right text-text-secondary/70">
                {cb?.filtered ? "n/a" : cb?.cost != null ? `$${cb.cost.toFixed(4)}` : "—"}
              </span>
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
