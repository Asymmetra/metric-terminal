"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface FundingEntry {
  timestamp: string;
  market_symbol?: string;
  symbol?: string;
  funding_rate?: number;
  rate?: number;
  payment?: number;
  amount?: number;
  position_size?: number;
  side?: string;
}

interface FundingLogProps {
  authority: string;
}

export function FundingLog({ authority }: FundingLogProps) {
  const [entries, setEntries] = useState<FundingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .getTraderFunding(authority, { limit: 50 })
      .then((res: any) => {
        const items = res.funding || res.data || [];
        setEntries(Array.isArray(items) ? items : []);
        setCursor(res.next_cursor || res.cursor);
        setHasMore(!!res.has_more || !!res.next_cursor);
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [authority]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.getTraderFunding(authority, { cursor, limit: 50 });
      const items = res.funding || res.data || [];
      setEntries((prev) => [...prev, ...(Array.isArray(items) ? items : [])]);
      setCursor(res.next_cursor || res.cursor);
      setHasMore(!!res.has_more || !!res.next_cursor);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [authority, cursor, loadingMore]);

  const netFunding = entries.reduce((s, e) => s + (e.payment || e.amount || 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading funding history...
        </span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No funding payments found</span>
      </div>
    );
  }

  return (
    <div className="border border-ember-border bg-surface-l1">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-ember-border">
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Time
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Market
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Rate
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Payment
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Position
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Side
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const symbol = e.market_symbol || e.symbol || "—";
              const rate = e.funding_rate || e.rate || 0;
              const payment = e.payment || e.amount || 0;
              const posSize = e.position_size || 0;
              const side = e.side || (posSize >= 0 ? "Long" : "Short");
              const ts = e.timestamp ? new Date(e.timestamp) : null;

              return (
                <tr
                  key={`${e.timestamp}-${i}`}
                  className="border-b border-ember-border/30 last:border-b-0 hover:bg-surface-l2/30 transition-colors"
                >
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[10px] text-text-secondary/70">
                    {ts ? `${ts.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}` : "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-text-primary">
                    {symbol}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-secondary">
                    {(rate * 100).toFixed(4)}%
                  </td>
                  <td
                    className={clsx(
                      "px-3 py-1.5 text-right font-mono text-[10px] tabular-nums",
                      payment > 0 ? "text-ember-green" : payment < 0 ? "text-ember-red" : "text-text-secondary/50"
                    )}
                  >
                    {payment > 0 ? "+" : ""}{formatUsd(payment)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-secondary">
                    {Math.abs(posSize).toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={clsx(
                        "font-mono text-[10px]",
                        /long|buy|bid/i.test(side) ? "text-ember-green" : "text-ember-red"
                      )}
                    >
                      {side}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Summary row */}
      <div className="flex items-center justify-between border-t border-ember-border px-3 py-2">
        <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
          Net Funding ({entries.length} payments)
        </span>
        <span
          className={clsx(
            "font-mono text-[11px] font-medium tabular-nums",
            netFunding > 0 ? "text-ember-green" : netFunding < 0 ? "text-ember-red" : "text-text-secondary"
          )}
        >
          {netFunding > 0 ? "+" : ""}{formatUsd(netFunding)}
        </span>
      </div>
      {hasMore && (
        <div className="border-t border-ember-border/40 px-3 py-2 text-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="font-mono text-[10px] text-ember-orange/70 hover:text-ember-orange transition-colors disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}
