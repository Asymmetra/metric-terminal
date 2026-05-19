"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import {
  normalizeTrade,
  filterByPeriod,
  computeTradeStats,
  normalizePnlSeries,
  periodDelta,
  pnlResolutionForPeriod,
  type Period,
  type TradeStats,
} from "@/lib/tradeStats";
import clsx from "clsx";

interface Props {
  authority: string;
  period: Period;
}

// Six headline stats for the selected period, laid out as a single strip.
// Sources:
//   • Realized PnL / Fees / Funding → /pnl delta (server-side cumulative)
//   • Volume / Win rate / # Trades  → client aggregation over /trades
//   • Net PnL is derived (realized − fees)
// Mixing sources means Volume + Win rate stay accurate at small-period
// granularities where the PnL endpoint's 1h/1d buckets would be lossy.
export function StatCards({ authority, period }: Props) {
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [pnlDelta, setPnlDelta] = useState<number | null>(null);
  const [feeDelta, setFeeDelta] = useState<number | null>(null);
  const [fundingDelta, setFundingDelta] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Trades: pull a healthy page, normalize, period-filter, aggregate.
    const tradesP = api
      .getTraderTrades(authority, { limit: 500 })
      .then((res: any) => (res?.trades ?? []).map(normalizeTrade))
      .catch(() => []);

    // PnL time-series for the requested period — take first/last delta.
    const { resolution, limit } = pnlResolutionForPeriod(period);
    const pnlP = api
      .getTraderPnl(authority, resolution, limit)
      .then((res: any) => normalizePnlSeries(res?.data ?? []))
      .catch(() => []);

    Promise.all([tradesP, pnlP]).then(([trades, pnl]) => {
      if (cancelled) return;
      setStats(computeTradeStats(filterByPeriod(trades, period)));
      setPnlDelta(periodDelta(pnl, "cumulativePnl"));
      setFeeDelta(periodDelta(pnl, "cumulativeFees"));
      setFundingDelta(periodDelta(pnl, "cumulativeFunding"));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [authority, period]);

  const realized = pnlDelta ?? 0;
  const fees = feeDelta ?? 0;
  const funding = fundingDelta ?? 0;
  const netPnl = realized - fees;

  return (
    <div className="grid grid-cols-2 gap-px border border-metric-border bg-metric-border/40 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard
        label="Net PnL"
        value={formatSigned(netPnl, "usd")}
        tone={tone(netPnl)}
        sub={loading ? "…" : `${formatSigned(realized, "usd")} realized`}
      />
      <StatCard
        label="Fees"
        value={formatUsd(fees)}
        tone="neutral"
        sub={loading ? "…" : percentOf(fees, Math.abs(realized), "of gross")}
      />
      <StatCard
        label="Funding"
        value={funding === 0 ? "$0.00" : formatSigned(funding, "usd")}
        tone={funding === 0 ? "neutral" : tone(-funding)} /* funding paid is a cost; positive means you paid */
        sub={
          loading
            ? "…"
            : funding === 0
              ? "no events"
              : funding > 0
                ? "paid"
                : "received"
        }
      />
      <StatCard
        label="Volume"
        value={stats ? formatCompactUsd(stats.volume) : "—"}
        tone="neutral"
        sub={loading ? "…" : `${stats?.total ?? 0} fills`}
      />
      <StatCard
        label="Win rate"
        value={stats ? `${(stats.winRate * 100).toFixed(0)}%` : "—"}
        tone="neutral"
        sub={
          loading
            ? "…"
            : `${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`
        }
      />
      <StatCard
        label="Profit factor"
        value={
          !stats
            ? "—"
            : stats.profitFactor === Infinity
              ? "∞"
              : stats.profitFactor === 0
                ? "—"
                : stats.profitFactor.toFixed(2)
        }
        tone={
          !stats || stats.profitFactor === 0
            ? "neutral"
            : stats.profitFactor >= 1
              ? "pos"
              : "neg"
        }
        sub={
          loading
            ? "…"
            : !stats || stats.total === 0
              ? "no trades"
              : stats.profitFactor === Infinity
                ? `${stats.wins}W / 0L`
                : stats.expectancy !== 0
                  ? `${formatSigned(stats.expectancy, "usd")} / trade`
                  : "—"
        }
      />
    </div>
  );
}

type Tone = "pos" | "neg" | "neutral";

function tone(n: number): Tone {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "neutral";
}

function formatSigned(n: number, kind: "usd"): string {
  const sign = n > 0 ? "+" : "";
  if (kind === "usd") return `${sign}${formatUsd(n)}`;
  return `${sign}${n}`;
}

function formatCompactUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return formatUsd(n);
}

function percentOf(part: number, whole: number, suffix: string): string {
  if (whole <= 0) return suffix;
  return `${((part / whole) * 100).toFixed(1)}% ${suffix}`;
}

function StatCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: Tone;
  sub?: string;
}) {
  const valueColor =
    tone === "pos" ? "text-metric-buy" : tone === "neg" ? "text-metric-sell" : "text-text-primary";
  return (
    <div className="flex flex-col gap-1.5 bg-surface-1 p-3">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
        {label}
      </span>
      <span className={clsx("font-mono text-base font-semibold tabular-nums", valueColor)}>
        {value}
      </span>
      {sub && (
        <span className="font-mono text-[10px] text-text-secondary/50">{sub}</span>
      )}
    </div>
  );
}
