"use client";

import { useEffect, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { fetch24hStats, type DayStats } from "@/lib/phoenix-candles";
import { formatPriceAuto, abbreviateNumber } from "@/lib/format";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col whitespace-nowrap">
      <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/60">
        {label}
      </span>
      <span className="font-mono text-xs text-text-primary">{children}</span>
    </div>
  );
}

function SymbolSelector() {
  const markets = useMarketStore((s) => s.markets);
  const selected = useMarketStore((s) => s.selectedSymbol);
  const setSelected = useMarketStore((s) => s.setSelectedSymbol);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 font-mono text-lg font-semibold text-text-primary transition-colors hover:text-metric-primary"
      >
        {selected}-PERP
        <svg className="h-3 w-3 text-text-secondary" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2.5 4.5L6 8l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-80 w-48 overflow-y-auto border border-metric-border bg-surface-1 shadow-xl scrollbar-hide">
          {markets.length === 0 && (
            <div className="px-3 py-2 font-mono text-[11px] text-text-secondary/60">loading…</div>
          )}
          {markets.map((m) => (
            <button
              key={m.symbol}
              onClick={() => {
                setSelected(m.symbol);
                setOpen(false);
              }}
              className={clsx(
                "flex w-full items-center justify-between px-3 py-1.5 font-mono text-[11px] transition-colors hover:bg-surface-2",
                m.symbol === selected ? "text-metric-primary" : "text-text-secondary"
              )}
            >
              <span>{m.symbol}</span>
              <span className="text-[9px] uppercase text-text-secondary/50">
                {m.phoenix ? "phoenix" : m.venues[0]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MarketHeader() {
  const symbol = useMarketStore((s) => s.selectedSymbol);
  const mark = useStatsStore((s) => s.marks[symbol]);
  const funding = useStatsStore((s) => s.funding[symbol]);
  const [day, setDay] = useState<DayStats | null>(null);

  // 24h stats from Phoenix candles; refresh on symbol change + every 60s.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const load = () =>
      fetch24hStats(symbol, ctrl.signal)
        .then((d) => !cancelled && setDay(d))
        .catch(() => {});
    setDay(null);
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [symbol]);

  const change = day?.change24h ?? null;
  const fundingPct = funding?.longPerHourPct ?? null;

  return (
    <div className="flex items-center gap-3 border-b border-metric-border bg-surface-1 px-3 py-2 sm:gap-6 sm:px-4 sm:py-2.5">
      <div className="shrink-0">
        <SymbolSelector />
      </div>

      {/* Stats scroll horizontally on narrow screens instead of squeezing the
          wallet button off the edge. */}
      <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto sm:gap-6 scrollbar-hide">
        <Stat label="Mark">{mark != null ? `$${formatPriceAuto(mark)}` : "—"}</Stat>
        <Stat label="24h Change">
          {change != null ? (
            <span className={change >= 0 ? "text-metric-buy" : "text-metric-sell"}>
              {change >= 0 ? "+" : ""}
              {(change * 100).toFixed(2)}%
            </span>
          ) : (
            "—"
          )}
        </Stat>
        <Stat label="24h High">{day?.high24h != null ? `$${formatPriceAuto(day.high24h)}` : "—"}</Stat>
        <Stat label="24h Low">{day?.low24h != null ? `$${formatPriceAuto(day.low24h)}` : "—"}</Stat>
        <Stat label="24h Volume">
          {day?.volume24hQuote ? `$${abbreviateNumber(day.volume24hQuote)}` : "—"}
        </Stat>
        <Stat label="1h Funding">
          {fundingPct != null ? (
            <span className={fundingPct >= 0 ? "text-metric-buy" : "text-metric-sell"}>
              {fundingPct >= 0 ? "+" : ""}
              {fundingPct.toFixed(4)}%
            </span>
          ) : (
            "—"
          )}
        </Stat>
      </div>

      <div className="shrink-0">
        <WalletMultiButton />
      </div>
    </div>
  );
}
