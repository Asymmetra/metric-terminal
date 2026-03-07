"use client";

import { useMemo, useCallback, useRef, useEffect, useState, memo } from "react";
import { useOrderbookStore } from "@/stores/orderbookStore";
import { formatPrice, formatSize } from "@/lib/format";
import clsx from "clsx";

interface OrderbookLevel {
  price: number;
  size: number;
}

const GROUPING_OPTIONS = [0.01, 0.05, 0.10, 0.50, 1.00, 5.00, 10.00];

function aggregateLevels(
  levels: OrderbookLevel[],
  increment: number,
  side: "bid" | "ask"
): OrderbookLevel[] {
  if (increment <= 0) return levels;
  const map = new Map<number, number>();
  for (const level of levels) {
    const bucket =
      side === "bid"
        ? Math.floor(level.price / increment) * increment
        : Math.ceil(level.price / increment) * increment;
    map.set(bucket, (map.get(bucket) || 0) + level.size);
  }
  const result = Array.from(map.entries()).map(([price, size]) => ({ price, size }));
  return side === "bid"
    ? result.sort((a, b) => b.price - a.price)
    : result.sort((a, b) => a.price - b.price);
}

interface RowProps {
  level: OrderbookLevel;
  cumulative: number;
  maxCumulative: number;
  side: "bid" | "ask";
  priceDecimals: number;
  onClickPrice: (price: number) => void;
}

const OrderbookRow = memo(function OrderbookRow({ level, cumulative, maxCumulative, side, priceDecimals, onClickPrice }: RowProps) {
  const depthPct = maxCumulative > 0 ? (cumulative / maxCumulative) * 100 : 0;
  const isBid = side === "bid";
  const prevSizeRef = useRef(level.size);
  const flashRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prevSizeRef.current !== level.size && flashRef.current) {
      prevSizeRef.current = level.size;
      const el = flashRef.current;
      el.classList.remove("ob-flash");
      void el.offsetWidth;
      el.classList.add("ob-flash");
    }
  }, [level.size]);

  return (
    <div
      onClick={() => onClickPrice(level.price)}
      className={clsx(
        "relative flex cursor-pointer items-center px-2 transition-colors duration-75",
        "hover:bg-surface-l2/60"
      )}
      style={{ height: "22px" }}
    >
      {/* Flash overlay */}
      <div
        ref={flashRef}
        className="absolute inset-0 pointer-events-none"
        style={{ "--flash-color": isBid ? "rgba(46,226,155,0.12)" : "rgba(242,59,78,0.12)" } as React.CSSProperties}
      />

      {/* Depth bar */}
      <div
        className={clsx(
          "absolute top-0 bottom-0 pointer-events-none",
          isBid ? "right-0 bg-ember-green/[0.12]" : "right-0 bg-ember-red/[0.12]"
        )}
        style={{ width: `${depthPct}%` }}
      />

      {/* Row data */}
      <div className="relative grid w-full grid-cols-3 font-mono text-[11px] leading-none">
        <span className={isBid ? "text-ember-green" : "text-ember-red"}>
          {formatPrice(level.price, priceDecimals)}
        </span>
        <span className="text-right text-text-primary/90">
          {formatSize(level.size)}
        </span>
        <span className="text-right text-text-secondary/60">
          {formatSize(cumulative)}
        </span>
      </div>
    </div>
  );
});

export function Orderbook() {
  const bids = useOrderbookStore((s) => s.bids);
  const asks = useOrderbookStore((s) => s.asks);
  const setFillPrice = useOrderbookStore((s) => s.setFillPrice);
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxRows, setMaxRows] = useState(15);
  const [grouping, setGrouping] = useState(0.01);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let debounceTimer: ReturnType<typeof setTimeout>;

    const observer = new ResizeObserver((entries) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (const entry of entries) {
          const totalHeight = entry.contentRect.height;
          const available = totalHeight - 48;
          const rowsPerSide = Math.max(1, Math.floor(available / 2 / 22));
          setMaxRows(rowsPerSide);
        }
      }, 100);
    });

    observer.observe(el);
    return () => {
      clearTimeout(debounceTimer);
      observer.disconnect();
    };
  }, []);

  const handleClickPrice = useCallback((price: number) => {
    setFillPrice(price);
  }, [setFillPrice]);

  // Aggregate levels by grouping increment
  const groupedBids = useMemo(() => aggregateLevels(bids, grouping, "bid"), [bids, grouping]);
  const groupedAsks = useMemo(() => aggregateLevels(asks, grouping, "ask"), [asks, grouping]);

  // Decimal places based on grouping
  const priceDecimals = grouping >= 1 ? 0 : grouping >= 0.1 ? 1 : 2;

  // Compute cumulative totals and max for depth bar proportions
  const { displayAsks, displayBids, maxCumulative } = useMemo(() => {
    const askSlice = groupedAsks.slice(0, maxRows);
    const bidSlice = groupedBids.slice(0, maxRows);

    // Cumulative: asks top→bottom (closest to spread first), bids top→bottom
    const askCumulatives = askSlice.reduce<number[]>((acc, l) => {
      acc.push((acc[acc.length - 1] ?? 0) + l.size);
      return acc;
    }, []);

    const bidCumulatives = bidSlice.reduce<number[]>((acc, l) => {
      acc.push((acc[acc.length - 1] ?? 0) + l.size);
      return acc;
    }, []);

    const maxCum = Math.max(
      askCumulatives[askCumulatives.length - 1] || 0,
      bidCumulatives[bidCumulatives.length - 1] || 0,
      1
    );

    return {
      displayAsks: askSlice.map((l, i) => ({ level: l, cumulative: askCumulatives[i] })),
      displayBids: bidSlice.map((l, i) => ({ level: l, cumulative: bidCumulatives[i] })),
      maxCumulative: maxCum,
    };
  }, [groupedBids, groupedAsks, maxRows]);

  const paddedAsks = useMemo(() => {
    const padded = [...displayAsks];
    while (padded.length < maxRows) {
      padded.push({ level: { price: 0, size: 0 }, cumulative: 0 });
    }
    return padded;
  }, [displayAsks, maxRows]);

  // Pad bids for visual symmetry
  const paddedBids = useMemo(() => {
    const padded = [...displayBids];
    while (padded.length < maxRows) {
      padded.push({ level: { price: 0, size: 0 }, cumulative: 0 });
    }
    return padded;
  }, [displayBids, maxRows]);

  // Spread from raw (ungrouped) best bid/ask for accuracy at all grouping levels
  const spread = useMemo(() => {
    if (bids[0] && asks[0]) {
      const spreadVal = asks[0].price - bids[0].price;
      const spreadPct = (spreadVal / asks[0].price) * 100;
      return { value: spreadVal, pct: spreadPct };
    }
    return null;
  }, [bids, asks]);

  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden">
      {/* Column headers */}
      <div className="flex items-center px-2 py-1 text-[10px] text-text-secondary/70">
        <div className="grid flex-1 grid-cols-3">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Total</span>
        </div>
        <select
          value={grouping}
          onChange={(e) => setGrouping(parseFloat(e.target.value))}
          className="ml-1 bg-surface-l2 border border-ember-border/50 px-1 py-0.5 font-mono text-[9px] text-text-secondary/70 focus:outline-none focus:border-ember-orange/40 cursor-pointer"
        >
          {GROUPING_OPTIONS.map((g) => (
            <option key={g} value={g}>
              {g >= 1 ? g.toFixed(0) : g.toFixed(2)}
            </option>
          ))}
        </select>
      </div>

      {/* Asks (sells) — reversed so cheapest is at bottom near spread */}
      <div className="flex flex-1 flex-col justify-end overflow-hidden">
        <div className="flex flex-col">
          {[...paddedAsks].reverse().map((item, i) =>
            item.level.price === 0 ? (
              <div key={`ask-empty-${i}`} style={{ height: "22px" }} />
            ) : (
              <OrderbookRow
                key={`ask-${item.level.price}`}
                level={item.level}
                cumulative={item.cumulative}
                maxCumulative={maxCumulative}
                side="ask"
                priceDecimals={priceDecimals}
                onClickPrice={handleClickPrice}
              />
            )
          )}
        </div>
      </div>

      {/* Spread bar */}
      <div className="flex items-center justify-between border-y border-ember-border/50 bg-ember-black/50 px-2" style={{ height: "24px" }}>
        <span className="font-mono text-[10px] text-text-secondary/70">
          Spread
        </span>
        <span className="font-mono text-[10px] text-text-secondary/70">
          {spread
            ? `${formatPrice(spread.value, 2)} (${spread.pct.toFixed(2)}%)`
            : "—"}
        </span>
      </div>

      {/* Bids (buys) */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-col">
          {paddedBids.map((item, i) =>
            item.level.price === 0 ? (
              <div key={`bid-empty-${i}`} style={{ height: "22px" }} />
            ) : (
              <OrderbookRow
                key={`bid-${item.level.price}`}
                level={item.level}
                cumulative={item.cumulative}
                maxCumulative={maxCumulative}
                side="bid"
                priceDecimals={priceDecimals}
                onClickPrice={handleClickPrice}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
