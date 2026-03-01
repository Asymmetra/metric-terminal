"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { formatPrice, formatPercent, formatUsd, abbreviateNumber } from "@/lib/format";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useMarkets } from "@/hooks/useMarkets";
import { useTraderSync } from "@/hooks/useTraderSync";
import { WalletButton } from "@/components/shared/WalletButton";
import { DepositWithdraw } from "@/components/terminal/DepositWithdraw";
import { useIsMobile } from "@/hooks/useIsMobile";
import clsx from "clsx";

function MarketSelector() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const markets = useMarketStore((s) => s.markets);
  const setSelectedSymbol = useMarketStore((s) => s.setSelectedSymbol);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 border border-ember-border bg-surface-l2 px-3 py-1.5 transition-colors hover:border-ember-orange/40"
      >
        <span className="font-mono text-sm font-medium text-text-primary">
          {selectedSymbol}-PERP
        </span>
        <svg
          className={clsx("h-3 w-3 text-text-secondary transition-transform", open && "rotate-180")}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-px min-w-[160px] border border-ember-border bg-surface-l1 shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
          {markets.map((m) => (
            <button
              key={m.symbol}
              onClick={() => {
                setSelectedSymbol(m.symbol);
                setOpen(false);
              }}
              className={clsx(
                "flex w-full items-center px-3 py-1.5 font-mono text-xs transition-colors",
                m.symbol === selectedSymbol
                  ? "bg-ember-orange/10 text-ember-orange"
                  : "text-text-secondary hover:bg-surface-l2 hover:text-text-primary"
              )}
            >
              {m.symbol}-PERP
            </button>
          ))}
          {markets.length === 0 && (
            <div className="px-3 py-1.5 font-mono text-xs text-text-secondary/70">
              Loading markets...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
  colorClass?: string;
}

function Stat({ label, value, colorClass }: StatProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] leading-none text-text-secondary/60">{label}</span>
      <span className={clsx("font-mono text-xs leading-none", colorClass || "text-text-secondary")}>
        {value}
      </span>
    </div>
  );
}

function StatSeparator() {
  return <div className="h-6 w-px bg-ember-border/60" />;
}

function FundingCountdown({ intervalSeconds }: { intervalSeconds: number }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    function update() {
      const now = Math.floor(Date.now() / 1000);
      const next = Math.ceil(now / intervalSeconds) * intervalSeconds;
      const diff = next - now;
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setRemaining(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [intervalSeconds]);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] leading-none text-text-secondary/60">Next Funding</span>
      <span className="font-mono text-xs leading-none text-text-secondary">{remaining}</span>
    </div>
  );
}

export function MarketHeader() {
  useWebSocket();
  useMarkets();
  useTraderSync();

  const isMobile = useIsMobile();
  const [showDepositModal, setShowDepositModal] = useState(false);
  const pathname = usePathname();

  const stats = useStatsStore((s) => s.stats);
  const open24h = useStatsStore((s) => s.open24h);
  const marketConfig = useMarketStore((s) => s.marketConfig);
  const traderConnected = useTraderStore((s) => s.connected);
  const portfolioValue = useTraderStore((s) => s.portfolioValue);
  const unrealizedPnl = useTraderStore((s) => s.unrealizedPnl);
  const collateral = useTraderStore((s) => s.collateral);

  if (isMobile) {
    return (
      <div className="border-b border-ember-border bg-surface-l1">
        {/* Row 1: Market selector + price + deposit + wallet */}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <div className="flex items-center gap-2">
            <MarketSelector />
            {stats && (
              <span
                className="font-mono text-base font-semibold text-text-primary"
                style={{ letterSpacing: "-0.02em" }}
              >
                ${formatPrice(stats.mark_price)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowDepositModal(true)}
              className="border border-ember-orange/60 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ember-orange transition-colors hover:bg-ember-orange/10"
            >
              Deposit
            </button>
            <WalletButton />
          </div>
        </div>

        {/* Row 2: Scrollable stats */}
        {stats && (
          <div className="scrollbar-hide flex items-center gap-3 overflow-x-auto border-t border-ember-border/50 px-3 py-1">
            {open24h != null && open24h > 0 && (() => {
              const change = stats.mark_price - open24h;
              const changePct = (change / open24h) * 100;
              const positive = change >= 0;
              return (
                <Stat
                  label="24h"
                  value={`${positive ? "+" : ""}${changePct.toFixed(2)}%`}
                  colorClass={positive ? "text-ember-green" : "text-ember-red"}
                />
              );
            })()}
            <Stat
              label="Funding"
              value={formatPercent(stats.funding_rate)}
              colorClass={stats.funding_rate >= 0 ? "text-ember-green" : "text-ember-red"}
            />
            {marketConfig && (
              <FundingCountdown intervalSeconds={marketConfig.fundingIntervalSeconds} />
            )}
            <Stat label="OI" value={`$${abbreviateNumber(stats.open_interest)}`} />
            <Stat label="Vol" value={`$${abbreviateNumber(stats.volume_24h)}`} />
          </div>
        )}

        {showDepositModal && <DepositWithdraw onClose={() => setShowDepositModal(false)} />}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 border-b border-ember-border bg-surface-l1 px-3 py-1.5">
      {/* Market selector */}
      <MarketSelector />

      {/* Mark price — prominent */}
      {stats && (
        <span
          className="font-mono text-lg font-semibold text-text-primary"
          style={{ letterSpacing: "-0.02em" }}
        >
          ${formatPrice(stats.mark_price)}
        </span>
      )}

      <StatSeparator />

      {/* Stats row */}
      {stats && (
        <>
          <Stat label="Last" value={`$${formatPrice(stats.last_price)}`} />

          {open24h != null && open24h > 0 && (() => {
            const change = stats.mark_price - open24h;
            const changePct = (change / open24h) * 100;
            const positive = change >= 0;
            return (
              <>
                <Stat
                  label="24h Change"
                  value={`${positive ? "+" : ""}${formatPrice(change)} (${positive ? "+" : ""}${changePct.toFixed(2)}%)`}
                  colorClass={positive ? "text-ember-green" : "text-ember-red"}
                />
              </>
            );
          })()}

          <StatSeparator />

          <Stat label="Index" value={`$${formatPrice(stats.index_price)}`} />

          <StatSeparator />

          <Stat
            label="Funding / 1h"
            value={formatPercent(stats.funding_rate)}
            colorClass={stats.funding_rate >= 0 ? "text-ember-green" : "text-ember-red"}
          />

          {marketConfig && (
            <FundingCountdown intervalSeconds={marketConfig.fundingIntervalSeconds} />
          )}

          <StatSeparator />

          <Stat label="Open Interest" value={`$${abbreviateNumber(stats.open_interest)}`} />

          <StatSeparator />

          <Stat label="24h Volume" value={`$${abbreviateNumber(stats.volume_24h)}`} />
        </>
      )}

      {/* Portfolio info (wallet connected) */}
      {traderConnected && (
        <>
          <StatSeparator />
          <Stat label="Portfolio" value={formatUsd(portfolioValue)} colorClass="text-text-primary" />
          <Stat
            label="Unreal. PnL"
            value={`${unrealizedPnl >= 0 ? "+" : ""}${formatUsd(unrealizedPnl)}`}
            colorClass={unrealizedPnl >= 0 ? "text-ember-green" : "text-ember-red"}
          />
          <Stat label="Collateral" value={formatUsd(collateral)} />
        </>
      )}

      {/* Spacer */}
      <div className="ml-auto" />

      {/* Nav links */}
      {(
        [
          { href: "/terminal", label: "Terminal" },
          { href: "/analytics", label: "Analytics" },
          { href: "/leaderboard", label: "Leaderboard" },
          { href: "/accounts", label: "Accounts" },
        ] as const
      ).map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className={clsx(
            "font-mono text-[10px] uppercase tracking-wider transition-colors",
            pathname === href
              ? "text-ember-orange"
              : "text-text-secondary/60 hover:text-text-secondary"
          )}
        >
          {label}
        </Link>
      ))}

      <StatSeparator />

      {/* Deposit button */}
      <button
        onClick={() => setShowDepositModal(true)}
        className="border border-ember-orange/60 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-ember-orange transition-colors hover:bg-ember-orange/10"
      >
        Deposit
      </button>

      {/* Wallet */}
      <WalletButton />

      {showDepositModal && <DepositWithdraw onClose={() => setShowDepositModal(false)} />}
    </div>
  );
}
