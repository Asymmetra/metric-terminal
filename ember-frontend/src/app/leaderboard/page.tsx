"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { WalletButton } from "@/components/shared/WalletButton";
import Link from "next/link";
import clsx from "clsx";

const ACCESS_KEY = "ember-access";

const PERIODS = [
  { key: "1d", label: "1D" },
  { key: "1w", label: "1W" },
  { key: "1m", label: "1M" },
  { key: "all", label: "ALL" },
];

interface LeaderboardEntry {
  authority: string;
  // `net_pnl` is the canonical field — already net of fees + funding per
  // Phoenix's PnL series. `pnl` is a deprecated alias kept for one rollout
  // cycle. `cumulative_pnl` is lifetime, also net.
  net_pnl?: number;
  pnl?: number;
  cumulative_pnl: number;
  // `gross_fees` is the period sum (taker + maker). `fees` was the legacy
  // taker-only field — both are surfaced for back-compat but already
  // reflected in net_pnl, so they should NOT be subtracted again.
  gross_fees?: number;
  fees: number;
  cumulative_funding?: number;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

export default function LeaderboardPage() {
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [period, setPeriod] = useState("1d");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalRegistered, setTotalRegistered] = useState(0);
  const [cached, setCached] = useState(false);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(ACCESS_KEY) === "1");
    setChecked(true);
  }, []);

  useEffect(() => {
    if (!authed) return;
    setLoading(true);
    api
      .getLeaderboard(period, 50)
      .then((res: any) => {
        setEntries(res.traders || []);
        setTotalRegistered(res.total_registered || 0);
        setCached(res.cached || false);
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [authed, period]);

  if (!checked) return null;

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ember-black">
        <div className="flex flex-col items-center gap-4">
          <span className="font-mono text-sm text-text-secondary">Access required</span>
          <Link
            href="/terminal"
            className="font-mono text-[11px] text-ember-orange hover:underline"
          >
            Go to Terminal
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-ember-black">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-ember-border bg-surface-l1 px-4 py-2">
        <div className="flex items-center gap-4">
          <Link href="/terminal" className="flex items-center gap-2 group">
            <div
              className="h-2 w-2 bg-ember-orange"
              style={{ boxShadow: "0 0 8px rgba(255,85,0,0.4)" }}
            />
            <span className="font-mono text-[11px] tracking-[0.2em] text-text-secondary/70 uppercase group-hover:text-text-primary transition-colors">
              Ember
            </span>
          </Link>
          <div className="h-4 w-px bg-ember-border" />
          <span className="font-mono text-xs font-medium text-text-primary uppercase tracking-wider">
            Leaderboard
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/terminal"
            className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors"
          >
            Terminal
          </Link>
          <Link
            href="/analytics"
            className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors"
          >
            Profile
          </Link>
          <WalletButton />
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 p-4">
        {/* Period selector + info */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={clsx(
                  "px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                  period === p.key
                    ? "bg-ember-orange/10 text-ember-orange border border-ember-orange/40"
                    : "text-text-secondary/60 border border-ember-border hover:text-text-secondary"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-text-secondary/40">
              {totalRegistered} traders registered
            </span>
            {cached && (
              <span className="font-mono text-[10px] text-text-secondary/30">cached</span>
            )}
          </div>
        </div>

        {/* Leaderboard table */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
              Computing rankings...
            </span>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <span className="font-mono text-sm text-text-secondary/40">
              No traders on the leaderboard yet
            </span>
            <span className="font-mono text-[10px] text-text-secondary/30">
              Connect your wallet on the terminal to auto-register
            </span>
          </div>
        ) : (
          <div className="overflow-hidden border border-ember-border">
            <table className="w-full">
              <thead>
                <tr className="border-b border-ember-border bg-surface-l1">
                  <th className="w-16 px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
                    Rank
                  </th>
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
                    Trader
                  </th>
                  <th
                    className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-wider text-text-secondary/60"
                    title="Net PnL over the selected period — already net of trading fees and funding payments. Do NOT subtract the Fees column from this value."
                  >
                    Period Net PnL
                  </th>
                  <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
                    Cumulative PnL
                  </th>
                  <th
                    className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-wider text-text-secondary/60"
                    title="Trading fees paid in the period (taker + maker). Already deducted from Net PnL — shown for attribution only."
                  >
                    Fees (info)
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr
                    key={entry.authority}
                    className="border-b border-ember-border/40 last:border-b-0 transition-colors hover:bg-surface-l1/50 cursor-pointer"
                    onClick={() => window.location.href = `/analytics?trader=${entry.authority}`}
                  >
                    <td className="w-16 px-3 py-2.5 text-center">
                      <span
                        className={clsx(
                          "font-mono text-xs font-medium",
                          i === 0
                            ? "text-ember-orange"
                            : i === 1
                            ? "text-text-primary"
                            : i === 2
                            ? "text-text-secondary"
                            : "text-text-secondary/50"
                        )}
                      >
                        #{i + 1}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-xs text-text-primary hover:text-ember-orange transition-colors">
                        {truncateAddress(entry.authority)}
                      </span>
                    </td>
                    {(() => {
                      const periodPnl = entry.net_pnl ?? entry.pnl ?? 0;
                      return (
                        <td
                          className={clsx(
                            "px-3 py-2.5 text-right font-mono text-xs tabular-nums",
                            periodPnl >= 0 ? "text-ember-green" : "text-ember-red"
                          )}
                        >
                          {periodPnl >= 0 ? "+" : ""}
                          {formatUsd(periodPnl)}
                        </td>
                      );
                    })()}
                    <td
                      className={clsx(
                        "px-3 py-2.5 text-right font-mono text-xs tabular-nums",
                        entry.cumulative_pnl >= 0 ? "text-ember-green" : "text-ember-red"
                      )}
                    >
                      {entry.cumulative_pnl >= 0 ? "+" : ""}
                      {formatUsd(entry.cumulative_pnl)}
                    </td>
                    <td
                      className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-text-secondary/70"
                      title="Already deducted from Net PnL — informational only."
                    >
                      {formatUsd(Math.abs(entry.gross_fees ?? entry.fees ?? 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
