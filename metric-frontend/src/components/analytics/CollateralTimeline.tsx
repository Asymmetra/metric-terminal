"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface CollateralEvent {
  timestamp: string;
  event_type: string;
  amount: number;
  balance_after?: number;
}

interface CollateralTimelineProps {
  authority: string;
}

export function CollateralTimeline({ authority }: CollateralTimelineProps) {
  const [events, setEvents] = useState<CollateralEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getTraderCollateralHistory(authority, 100)
      .then((res: any) => {
        setEvents(res.data || []);
      })
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [authority]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading collateral history...
        </span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">
          No collateral events found
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0 overflow-y-auto">
      {events.map((ev, i) => {
        const isDeposit =
          ev.event_type?.toLowerCase().includes("deposit") ||
          ev.amount > 0;
        const date = new Date(ev.timestamp);
        const formatted = date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        return (
          <div
            key={`${ev.timestamp}-${i}`}
            className="flex items-center gap-3 border-b border-metric-border/40 px-4 py-2.5 last:border-b-0"
          >
            {/* Dot indicator */}
            <div
              className={clsx(
                "h-1.5 w-1.5 shrink-0",
                isDeposit ? "bg-metric-buy" : "bg-metric-sell"
              )}
            />

            {/* Event type */}
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 w-20 shrink-0">
              {isDeposit ? "Deposit" : "Withdraw"}
            </span>

            {/* Amount */}
            <span
              className={clsx(
                "font-mono text-xs tabular-nums",
                isDeposit ? "text-metric-buy" : "text-metric-sell"
              )}
            >
              {isDeposit ? "+" : "-"}
              {formatUsd(Math.abs(ev.amount))}
            </span>

            {/* Balance after */}
            {ev.balance_after != null && (
              <span className="ml-auto font-mono text-[10px] text-text-secondary/40">
                bal: {formatUsd(ev.balance_after)}
              </span>
            )}

            {/* Timestamp */}
            <span className="ml-auto font-mono text-[10px] text-text-secondary/40 shrink-0">
              {formatted}
            </span>
          </div>
        );
      })}
    </div>
  );
}
