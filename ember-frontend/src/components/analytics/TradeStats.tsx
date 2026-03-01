"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface Trade {
  timestamp: string;
  side: string;
  price: number;
  size: number;
  fee: number;
  pnl?: number;
  symbol?: string;
}

interface Stats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  totalFees: number;
  profitFactor: number;
}

function computeStats(trades: Trade[]): Stats {
  const wins = trades.filter((t) => (t.pnl || 0) > 0);
  const losses = trades.filter((t) => (t.pnl || 0) < 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);
  const grossWins = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnl,
    avgWin: wins.length > 0 ? grossWins / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLosses / losses.length : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map((t) => t.pnl || 0)) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses.map((t) => t.pnl || 0)) : 0,
    totalFees,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
  };
}

interface TradeStatsProps {
  authority: string;
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1 border border-ember-border bg-surface-l1 p-3">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
        {label}
      </span>
      <span className={clsx("font-mono text-sm", color || "text-text-primary")}>{value}</span>
    </div>
  );
}

export function TradeStats({ authority }: TradeStatsProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getTraderTrades(authority)
      .then((res: any) => {
        const trades: Trade[] = res.trades || res.data || res || [];
        setStats(computeStats(Array.isArray(trades) ? trades : []));
      })
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [authority]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
          Loading trade stats...
        </span>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      <StatBox label="Total Trades" value={stats.totalTrades.toString()} />
      <StatBox
        label="Win Rate"
        value={`${(stats.winRate * 100).toFixed(1)}%`}
        color={stats.winRate >= 0.5 ? "text-ember-green" : "text-ember-red"}
      />
      <StatBox label="Wins / Losses" value={`${stats.wins} / ${stats.losses}`} />
      <StatBox
        label="Total PnL"
        value={`${stats.totalPnl >= 0 ? "+" : ""}${formatUsd(stats.totalPnl)}`}
        color={stats.totalPnl >= 0 ? "text-ember-green" : "text-ember-red"}
      />
      <StatBox label="Avg Win" value={`+${formatUsd(stats.avgWin)}`} color="text-ember-green" />
      <StatBox label="Avg Loss" value={formatUsd(stats.avgLoss * -1)} color="text-ember-red" />
      <StatBox label="Largest Win" value={`+${formatUsd(stats.largestWin)}`} color="text-ember-green" />
      <StatBox label="Largest Loss" value={formatUsd(stats.largestLoss)} color="text-ember-red" />
      <StatBox label="Total Fees" value={formatUsd(stats.totalFees)} />
      <StatBox
        label="Profit Factor"
        value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
        color={stats.profitFactor >= 1 ? "text-ember-green" : "text-ember-red"}
      />
    </div>
  );
}
