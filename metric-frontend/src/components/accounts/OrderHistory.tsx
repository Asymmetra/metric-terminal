"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface Order {
  timestamp?: string;
  created_at?: string;
  market_symbol?: string;
  symbol?: string;
  side?: string;
  price?: number | string;
  size?: number | string;
  filled?: number | string;
  filled_size?: number | string;
  status?: string;
  order_type?: string;
  type?: string;
}

type FilterTab = "all" | "filled" | "cancelled";

interface OrderHistoryProps {
  authority: string;
}

export function OrderHistory({ authority }: OrderHistoryProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<FilterTab>("all");

  useEffect(() => {
    setLoading(true);
    api
      .getTraderOrders(authority, { limit: 50 })
      .then((res: any) => {
        const items = res.orders || res.data || [];
        setOrders(Array.isArray(items) ? items : []);
        setCursor(res.next_cursor || res.cursor);
        setHasMore(!!res.has_more || !!res.next_cursor);
      })
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
  }, [authority]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.getTraderOrders(authority, { cursor, limit: 50 });
      const items = res.orders || res.data || [];
      setOrders((prev) => [...prev, ...(Array.isArray(items) ? items : [])]);
      setCursor(res.next_cursor || res.cursor);
      setHasMore(!!res.has_more || !!res.next_cursor);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [authority, cursor, loadingMore]);

  const filtered = orders.filter((o) => {
    const status = (o.status || "").toLowerCase();
    if (filter === "filled") return status === "filled" || status === "complete";
    if (filter === "cancelled") return status === "cancelled" || status === "canceled";
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading order history...
        </span>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40">No order history found</span>
      </div>
    );
  }

  return (
    <div className="border border-metric-border bg-surface-1">
      {/* Filter tabs */}
      <div className="flex border-b border-metric-border">
        {(["all", "filled", "cancelled"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={clsx(
              "flex-1 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors",
              filter === tab
                ? "border-b border-metric-primary text-text-primary"
                : "text-text-secondary/50 hover:text-text-secondary"
            )}
          >
            {tab} {tab !== "all" && `(${orders.filter((o) => {
              const s = (o.status || "").toLowerCase();
              if (tab === "filled") return s === "filled" || s === "complete";
              return s === "cancelled" || s === "canceled";
            }).length})`}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-metric-border/60">
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Time
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Market
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Type
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Side
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Price
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Size
              </th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Filled
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((o, i) => {
              const symbol = o.market_symbol || o.symbol || "—";
              const side = o.side || "—";
              const isBuy = /buy|bid|long/i.test(side);
              const price = typeof o.price === "string" ? parseFloat(o.price) : o.price || 0;
              const size = typeof o.size === "string" ? parseFloat(o.size) : o.size || 0;
              const filledVal = typeof (o.filled ?? o.filled_size) === "string"
                ? parseFloat((o.filled ?? o.filled_size) as string)
                : (o.filled ?? o.filled_size ?? 0) as number;
              const status = (o.status || "unknown").toLowerCase();
              const orderType = o.order_type || o.type || "limit";
              const ts = o.timestamp || o.created_at;
              const date = ts ? new Date(ts) : null;

              const statusColor =
                status === "filled" || status === "complete"
                  ? "text-metric-buy"
                  : status === "cancelled" || status === "canceled"
                  ? "text-metric-sell"
                  : status === "open" || status === "active"
                  ? "text-metric-primary"
                  : "text-text-secondary/50";

              return (
                <tr
                  key={`${ts}-${i}`}
                  className="border-b border-metric-border/30 last:border-b-0 hover:bg-surface-2/30 transition-colors"
                >
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[10px] text-text-secondary/70">
                    {date ? `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}` : "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-text-primary">
                    {symbol}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-text-secondary/70 uppercase">
                    {orderType}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={clsx("font-mono text-[10px] uppercase", isBuy ? "text-metric-buy" : "text-metric-sell")}>
                      {isBuy ? "Buy" : "Sell"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-secondary">
                    {formatUsd(price)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-primary">
                    {Math.abs(size).toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums text-text-secondary">
                    {filledVal > 0 ? filledVal.toFixed(4) : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={clsx("font-mono text-[10px] uppercase", statusColor)}>
                      {status}
                    </span>
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
