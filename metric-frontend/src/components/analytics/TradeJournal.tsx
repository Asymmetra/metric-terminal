"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface Trade {
  timestamp: string;
  market_symbol?: string;
  symbol?: string;
  side?: string;
  instruction_type?: string;
  base_qty?: string;
  quote_qty?: string;
  price?: string;
  size?: number;
  fee?: number;
  pnl?: number;
  transaction_signature?: string;
}

interface TradeJournalProps {
  authority: string;
}

export function TradeJournal({ authority }: TradeJournalProps) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .getTraderTrades(authority, { limit: 50 })
      .then((res: any) => {
        const items = res.trades || res.data || [];
        setTrades(Array.isArray(items) ? items : []);
        setCursor(res.next_cursor || res.cursor);
        setHasMore(!!res.has_more || !!res.next_cursor);
      })
      .catch(() => setTrades([]))
      .finally(() => setLoading(false));
  }, [authority]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.getTraderTrades(authority, { cursor, limit: 50 });
      const items = res.trades || res.data || [];
      setTrades((prev) => [...prev, ...(Array.isArray(items) ? items : [])]);
      setCursor(res.next_cursor || res.cursor);
      setHasMore(!!res.has_more || !!res.next_cursor);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [authority, cursor, loadingMore]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading trade journal...
        </span>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No trades found</span>
      </div>
    );
  }

  return (
    <div className="border border-metric-border bg-surface-1">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-metric-border">
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Time
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Market
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Side
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Size
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Price
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                PnL
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Fee
              </th>
              <th className="px-3 py-2 text-center font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Tx
              </th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const symbol = t.market_symbol || t.symbol || "—";
              const side = t.side || t.instruction_type || "—";
              const isBuy = /buy|bid|long/i.test(side);
              const size = t.base_qty ? parseFloat(t.base_qty) : t.size || 0;
              const price = t.price ? parseFloat(t.price) : t.quote_qty && t.base_qty ? parseFloat(t.quote_qty) / parseFloat(t.base_qty) : 0;
              const pnl = t.pnl || 0;
              const fee = t.fee || (t.quote_qty ? parseFloat(t.quote_qty) * 0 : 0);
              const ts = t.timestamp ? new Date(t.timestamp) : null;
              const sig = t.transaction_signature;

              return (
                <tr
                  key={`${t.timestamp}-${i}`}
                  className="border-b border-metric-border/30 last:border-b-0 hover:bg-surface-2/30 transition-colors"
                >
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[10px] text-text-secondary/70">
                    {ts ? `${ts.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}` : "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-text-primary">
                    {symbol}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={clsx(
                        "font-mono text-[10px] uppercase",
                        isBuy ? "text-metric-buy" : "text-metric-sell"
                      )}
                    >
                      {isBuy ? "Buy" : "Sell"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-primary">
                    {Math.abs(size).toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-secondary">
                    {formatUsd(price)}
                  </td>
                  <td
                    className={clsx(
                      "px-3 py-1.5 text-right font-mono text-[10px] tabular-nums",
                      pnl > 0 ? "text-metric-buy" : pnl < 0 ? "text-metric-sell" : "text-text-secondary/50"
                    )}
                  >
                    {pnl !== 0 ? `${pnl > 0 ? "+" : ""}${formatUsd(pnl)}` : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-secondary/50">
                    {fee > 0 ? formatUsd(fee) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    {sig ? (
                      <a
                        href={`https://solscan.io/tx/${sig}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[10px] text-metric-primary/70 hover:text-metric-primary transition-colors"
                      >
                        View
                      </a>
                    ) : (
                      <span className="font-mono text-[10px] text-text-secondary/30">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="border-t border-metric-border/40 px-3 py-2 text-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="font-mono text-[10px] text-metric-primary/70 hover:text-metric-primary transition-colors disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}
