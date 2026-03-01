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
  expectancy: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  feeToPnlRatio: number;
  netPnl: number;
  sharpeRatio: number | null;
}

function computeStats(trades: Trade[]): Stats {
  const wins = trades.filter((t) => (t.pnl || 0) > 0);
  const losses = trades.filter((t) => (t.pnl || 0) < 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalFees = trades.reduce((s, t) => s + (t.fee || 0), 0);
  const grossWins = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));

  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const lossRate = trades.length > 0 ? losses.length / trades.length : 0;
  const avgWin = wins.length > 0 ? grossWins / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;

  // Expectancy = (winRate * avgWin) - (lossRate * avgLoss)
  const expectancy = winRate * avgWin - lossRate * avgLoss;

  // Max consecutive wins/losses
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;
  for (const t of trades) {
    if ((t.pnl || 0) > 0) {
      currentWinStreak++;
      currentLossStreak = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWinStreak);
    } else if ((t.pnl || 0) < 0) {
      currentLossStreak++;
      currentWinStreak = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLossStreak);
    }
  }

  // Fee-to-PnL ratio
  const feeToPnlRatio = Math.abs(totalPnl) > 0 ? totalFees / Math.abs(totalPnl) : 0;

  // Net PnL (after fees + funding — funding not available here, so just fees)
  const netPnl = totalPnl - totalFees;

  // Sharpe ratio placeholder — needs daily returns, computed via PnL endpoint
  // Will be set asynchronously if daily data is available
  const sharpeRatio: number | null = null;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl,
    avgWin,
    avgLoss,
    largestWin: wins.length > 0 ? Math.max(...wins.map((t) => t.pnl || 0)) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses.map((t) => t.pnl || 0)) : 0,
    totalFees,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
    expectancy,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    feeToPnlRatio,
    netPnl,
    sharpeRatio,
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
    const fetchData = async () => {
      try {
        const tradesRes = await api.getTraderTrades(authority);
        const trades: Trade[] = tradesRes.trades || tradesRes.data || tradesRes || [];
        const computed = computeStats(Array.isArray(trades) ? trades : []);

        // Compute Sharpe from daily PnL
        try {
          const pnlRes = await api.getTraderPnl(authority, "1d", 365);
          const points: any[] = pnlRes.data || [];
          if (points.length > 1) {
            const dailyReturns: number[] = [];
            for (let i = 1; i < points.length; i++) {
              const prev = points[i - 1].cumulative_pnl || 0;
              const curr = points[i].cumulative_pnl || 0;
              dailyReturns.push(curr - prev);
            }
            const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
            const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length;
            const stdDev = Math.sqrt(variance);
            computed.sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(365) : null;
          }
        } catch { /* Sharpe computation is optional */ }

        setStats(computed);
      } catch {
        setStats(null);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
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
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
      <StatBox
        label="Net PnL"
        value={`${stats.netPnl >= 0 ? "+" : ""}${formatUsd(stats.netPnl)}`}
        color={stats.netPnl >= 0 ? "text-ember-green" : "text-ember-red"}
      />
      <StatBox label="Avg Win" value={`+${formatUsd(stats.avgWin)}`} color="text-ember-green" />
      <StatBox label="Avg Loss" value={formatUsd(stats.avgLoss * -1)} color="text-ember-red" />
      <StatBox label="Largest Win" value={`+${formatUsd(stats.largestWin)}`} color="text-ember-green" />
      <StatBox label="Largest Loss" value={formatUsd(stats.largestLoss)} color="text-ember-red" />
      <StatBox
        label="Profit Factor"
        value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
        color={stats.profitFactor >= 1 ? "text-ember-green" : "text-ember-red"}
      />
      <StatBox
        label="Expectancy"
        value={`${stats.expectancy >= 0 ? "+" : ""}${formatUsd(stats.expectancy)}`}
        color={stats.expectancy >= 0 ? "text-ember-green" : "text-ember-red"}
      />
      <StatBox
        label="Sharpe Ratio"
        value={stats.sharpeRatio != null ? stats.sharpeRatio.toFixed(2) : "—"}
        color={stats.sharpeRatio != null && stats.sharpeRatio >= 1 ? "text-ember-green" : stats.sharpeRatio != null && stats.sharpeRatio < 0 ? "text-ember-red" : undefined}
      />
      <StatBox label="Win Streak" value={stats.maxConsecutiveWins.toString()} color="text-ember-green" />
      <StatBox label="Loss Streak" value={stats.maxConsecutiveLosses.toString()} color="text-ember-red" />
      <StatBox
        label="Fee/PnL Ratio"
        value={`${(stats.feeToPnlRatio * 100).toFixed(1)}%`}
        color={stats.feeToPnlRatio > 0.5 ? "text-ember-red" : "text-text-primary"}
      />
      <StatBox label="Total Fees" value={formatUsd(stats.totalFees)} />
    </div>
  );
}
