"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface MarketPnl {
  symbol: string;
  trades: number;
  pnl: number;
  fees: number;
  volume: number;
}

interface MarketBreakdownProps {
  authority: string;
}

export function MarketBreakdown({ authority }: MarketBreakdownProps) {
  const [markets, setMarkets] = useState<MarketPnl[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getTraderTrades(authority)
      .then((res: any) => {
        const trades: any[] = res.trades || res.data || res || [];
        if (!Array.isArray(trades)) {
          setMarkets([]);
          return;
        }

        const byMarket: Record<string, MarketPnl> = {};
        for (const t of trades) {
          const sym = t.symbol || t.market || "Unknown";
          if (!byMarket[sym]) {
            byMarket[sym] = { symbol: sym, trades: 0, pnl: 0, fees: 0, volume: 0 };
          }
          byMarket[sym].trades++;
          byMarket[sym].pnl += t.pnl || 0;
          byMarket[sym].fees += t.fee || 0;
          byMarket[sym].volume += Math.abs((t.price || 0) * (t.size || 0));
        }

        setMarkets(
          Object.values(byMarket).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
        );
      })
      .catch(() => setMarkets([]))
      .finally(() => setLoading(false));
  }, [authority]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading market breakdown...
        </span>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No trade data</span>
      </div>
    );
  }

  return (
    <div className="overflow-hidden border border-ember-border">
      <table className="w-full">
        <thead>
          <tr className="border-b border-ember-border bg-surface-l1">
            <th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              Market
            </th>
            <th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              Trades
            </th>
            <th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              PnL
            </th>
            <th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              Fees
            </th>
            <th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              Volume
            </th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => (
            <tr key={m.symbol} className="border-b border-ember-border/40 last:border-b-0">
              <td className="px-3 py-2 font-mono text-xs text-text-primary">{m.symbol}</td>
              <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                {m.trades}
              </td>
              <td
                className={clsx(
                  "px-3 py-2 text-right font-mono text-xs",
                  m.pnl >= 0 ? "text-ember-green" : "text-ember-red"
                )}
              >
                {m.pnl >= 0 ? "+" : ""}
                {formatUsd(m.pnl)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                {formatUsd(m.fees)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                {formatUsd(m.volume)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
