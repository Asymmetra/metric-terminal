"use client";

import { useState } from "react";
import clsx from "clsx";
import { Orderbook } from "@/components/terminal/Orderbook";
import { VenueQuotes } from "@/components/terminal/VenueQuotes";

/**
 * Left-panel container with an Order Book | Venues tab toggle (mirrors the
 * Positions / Trade History pattern). Order Book is the Phoenix L2 depth; Venues
 * shows per-venue quotes + the route Auto would take.
 */

type Tab = "book" | "venues";

export function MarketDepthPanel() {
  const [tab, setTab] = useState<Tab>("book");
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-metric-border bg-surface-1 px-3">
        <div className="flex gap-4">
          {(
            [
              ["book", "Order Book"],
              ["venues", "Venues"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={clsx(
                "relative py-2 font-mono text-[11px] uppercase tracking-wider transition-colors",
                tab === key ? "text-metric-primary" : "text-text-secondary/60 hover:text-text-secondary"
              )}
            >
              {label}
              {tab === key && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-metric-primary" />}
            </button>
          ))}
        </div>
        <span className="font-mono text-[9px] uppercase text-text-secondary/50">{tab === "book" ? "Phoenix" : "Auto"}</span>
      </div>
      <div className="min-h-0 flex-1">{tab === "book" ? <Orderbook /> : <VenueQuotes />}</div>
    </div>
  );
}
