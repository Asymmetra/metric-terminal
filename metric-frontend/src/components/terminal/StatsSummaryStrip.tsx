"use client";

import { useEffect, useState } from "react";
import { imperial } from "@/lib/imperial/client";
import type { StatsSummaryResponse } from "@/lib/imperial/types";
import { abbreviateNumber } from "@/lib/format";

/** Compact-currency a decimal-string Usd field; "—" when it doesn't parse. */
function fmtUsd(value: string | undefined): string {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "—";
  return `$${abbreviateNumber(n)}`;
}

function fmtCount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return abbreviateNumber(value).replace(/\.00$/, "");
}

/**
 * One-line strip of protocol-wide stats from GET /stats/summary: 24h volume,
 * open interest, and active traders (24h). Self-contained — fetches once on
 * mount and renders nothing if the call fails (never throws).
 */
export function StatsSummaryStrip() {
  const [summary, setSummary] = useState<StatsSummaryResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    imperial
      .getStatsSummary()
      .then((s) => !cancelled && setSummary(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!summary) return null;

  return (
    <div className="flex shrink-0 items-center gap-3 whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">
      <span>
        24h Vol <span className="text-text-primary">{fmtUsd(summary.volume24hUsd)}</span>
      </span>
      <span>
        OI <span className="text-text-primary">{fmtUsd(summary.openInterestUsd)}</span>
      </span>
      <span>
        Traders 24h <span className="text-text-primary">{fmtCount(summary.activeTraders24h)}</span>
      </span>
    </div>
  );
}
