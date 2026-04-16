"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { sdkNum, type Period } from "@/lib/tradeStats";
import clsx from "clsx";

const PERIODS: Period[] = ["24h", "7d", "30d", "all"];
const PERIOD_LABELS: Record<Period, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "All time",
};

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface Props {
  authority: string;
  viewingOther: boolean;
  period: Period;
  onPeriodChange: (p: Period) => void;
}

export function ProfileHeader({ authority, viewingOther, period, onPeriodChange }: Props) {
  const [equity, setEquity] = useState<number | null>(null);
  const [unrealized, setUnrealized] = useState<number | null>(null);
  const [lifetimeNet, setLifetimeNet] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Account equity = sum of portfolioValue across all subaccounts
  useEffect(() => {
    let cancelled = false;
    api
      .getTrader(authority)
      .then((res: any) => {
        if (cancelled) return;
        const accounts: any[] = res?.accounts ?? [];
        let eq = 0;
        let upnl = 0;
        for (const a of accounts) {
          eq += sdkNum(a.portfolioValue);
          upnl += sdkNum(a.unrealizedPnl);
        }
        setEquity(eq);
        setUnrealized(upnl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authority]);

  // Lifetime net PnL = last cumulativePnl − last cumulativeTakerFee
  useEffect(() => {
    let cancelled = false;
    api
      .getTraderPnl(authority, "1d", 1000)
      .then((res: any) => {
        if (cancelled) return;
        const data: any[] = res?.data ?? [];
        if (data.length === 0) {
          setLifetimeNet(0);
          return;
        }
        const last = data[data.length - 1];
        setLifetimeNet(sdkNum(last.cumulativePnl) - sdkNum(last.cumulativeTakerFee));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authority]);

  const copyAddress = () => {
    navigator.clipboard.writeText(authority).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const netPositive = (lifetimeNet ?? 0) >= 0;
  const upnlPositive = (unrealized ?? 0) >= 0;

  return (
    <div className="border border-ember-border bg-surface-l1">
      {/* Top row: address + viewing indicator + period selector */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ember-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={copyAddress}
            title="Copy full address"
            className="group flex items-center gap-2 font-mono text-[11px] text-text-primary transition-colors hover:text-ember-orange"
          >
            <span>{truncateAddress(authority)}</span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/40 group-hover:text-ember-orange">
              {copied ? "copied" : "copy"}
            </span>
          </button>
          {viewingOther && (
            <span className="border border-ember-orange/40 bg-ember-orange/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ember-orange">
              viewing
            </span>
          )}
        </div>
        <PeriodSelector period={period} onChange={onPeriodChange} />
      </div>

      {/* Bottom row: headline equity + lifetime net PnL */}
      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-3">
        <BigStat
          label="Equity"
          value={equity != null ? formatUsd(equity) : "—"}
          sub={
            unrealized != null
              ? `${upnlPositive ? "+" : ""}${formatUsd(unrealized)} uPnL`
              : undefined
          }
          subClass={upnlPositive ? "text-ember-green" : "text-ember-red"}
        />
        <BigStat
          label="Lifetime net PnL"
          value={lifetimeNet != null ? `${netPositive ? "+" : ""}${formatUsd(lifetimeNet)}` : "—"}
          valueClass={
            lifetimeNet == null
              ? "text-text-secondary"
              : netPositive
                ? "text-ember-green"
                : "text-ember-red"
          }
          sub="after fees"
        />
        <div className="hidden sm:block" />
      </div>
    </div>
  );
}

function PeriodSelector({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div className="flex items-center gap-px border border-ember-border/60 bg-ember-black">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={clsx(
            "px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
            period === p
              ? "bg-ember-orange/15 text-ember-orange"
              : "text-text-secondary/60 hover:text-text-secondary"
          )}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

function BigStat({
  label,
  value,
  valueClass,
  sub,
  subClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
  sub?: string;
  subClass?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
        {label}
      </span>
      <span
        className={clsx("font-mono text-2xl font-semibold", valueClass || "text-text-primary")}
        style={{ letterSpacing: "-0.02em" }}
      >
        {value}
      </span>
      {sub && (
        <span className={clsx("font-mono text-[10px]", subClass || "text-text-secondary/60")}>
          {sub}
        </span>
      )}
    </div>
  );
}
