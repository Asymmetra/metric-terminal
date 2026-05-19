"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import {
  computePerMarket,
  filterByPeriod,
  normalizeTrade,
  type NormalizedTrade,
  type PerMarketStats,
  type Period,
} from "@/lib/tradeStats";
import { useProfileDetailStore } from "@/stores/profileDetailStore";
import clsx from "clsx";

const PERIOD_LABEL: Record<Period, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "all time",
};

interface Props {
  authority: string;
  period: Period;
}

// Per-market breakdown: each row a market, columns for trade count, volume,
// realized PnL, fees, win rate. Sorted by volume descending so the markets
// the trader is most active in lead.
export function MarketBreakdownGrid({ authority, period }: Props) {
  const [rows, setRows] = useState<PerMarketStats[] | null>(null);
  const [allRows, setAllRows] = useState<PerMarketStats[] | null>(null);
  const [trades, setTrades] = useState<NormalizedTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const openDetail = useProfileDetailStore((s) => s.openPerMarket);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getTraderTrades(authority, { limit: 500 })
      .then((res: any) => {
        if (cancelled) return;
        const ts: NormalizedTrade[] = (res?.trades ?? []).map(normalizeTrade);
        setTrades(ts);
        setRows(computePerMarket(filterByPeriod(ts, period)));
        setAllRows(computePerMarket(ts));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setAllRows([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authority, period]);

  // Recompute the period-filtered rows when the period changes without refetching.
  useEffect(() => {
    if (trades.length === 0) return;
    setRows(computePerMarket(filterByPeriod(trades, period)));
  }, [period, trades]);

  const maxVolume = rows?.reduce((m, r) => (r.volume > m ? r.volume : m), 0) ?? 0;
  const hiddenMarkets =
    allRows && rows ? Math.max(0, allRows.length - rows.length) : 0;

  return (
    <div className="border border-metric-border bg-surface-1">
      <div className="flex items-center justify-between border-b border-metric-border/60 px-4 py-2.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
            Per market
          </span>
          <span className="font-mono text-[9px] text-text-secondary/40">
            · {PERIOD_LABEL[period]}
          </span>
        </div>
        <span className="font-mono text-[10px] text-text-secondary/40">
          {rows?.length ?? 0} {rows?.length === 1 ? "market" : "markets"}
          {hiddenMarkets > 0 ? ` · ${hiddenMarkets} hidden` : ""}
        </span>
      </div>

      {loading && (
        <div className="py-8 text-center font-mono text-[10px] text-text-secondary/40">
          Loading…
        </div>
      )}

      {!loading && rows && rows.length === 0 && (
        <div className="py-8 text-center font-mono text-[10px] text-text-secondary/40">
          No trades in this period.
        </div>
      )}

      {!loading && rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-text-secondary/50">
                <th className="px-4 py-1.5 text-left font-mono font-normal uppercase tracking-wider">Market</th>
                <th className="px-4 py-1.5 text-right font-mono font-normal uppercase tracking-wider">Trades</th>
                <th className="px-4 py-1.5 text-right font-mono font-normal uppercase tracking-wider">Volume</th>
                <th className="px-4 py-1.5 text-right font-mono font-normal uppercase tracking-wider">Realized PnL</th>
                <th className="px-4 py-1.5 text-right font-mono font-normal uppercase tracking-wider">Fees</th>
                <th className="px-4 py-1.5 text-right font-mono font-normal uppercase tracking-wider">Net</th>
                <th className="px-4 py-1.5 text-right font-mono font-normal uppercase tracking-wider">Win rate</th>
                <th className="px-4 py-1.5 font-mono font-normal uppercase tracking-wider text-left">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const positive = r.realizedPnl >= 0;
                const net = r.realizedPnl - r.fees;
                const netPositive = net >= 0;
                const sharePct = maxVolume > 0 ? (r.volume / maxVolume) * 100 : 0;
                return (
                  <tr
                    key={r.symbol}
                    onClick={() => openDetail(r, period)}
                    className="cursor-pointer border-t border-metric-border/40 font-mono transition-colors hover:bg-surface-2/40"
                  >
                    <td className="px-4 py-1.5 text-text-primary">{r.symbol}-PERP</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-text-secondary/80">{r.trades}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-text-secondary/80">{compactUsd(r.volume)}</td>
                    <td className={clsx("px-4 py-1.5 text-right tabular-nums", positive ? "text-metric-buy" : "text-metric-sell")}>
                      {positive ? "+" : ""}{formatUsd(r.realizedPnl)}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-text-secondary/70">
                      {formatUsd(r.fees)}
                    </td>
                    <td className={clsx("px-4 py-1.5 text-right tabular-nums", netPositive ? "text-metric-buy" : "text-metric-sell")}>
                      {netPositive ? "+" : ""}{formatUsd(net)}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-text-secondary/80">
                      {(r.winRate * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-1.5">
                      <div className="h-1 w-24 bg-metric-border/40">
                        <div className="h-full bg-metric-primary/60" style={{ width: `${sharePct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function compactUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return formatUsd(n);
}
