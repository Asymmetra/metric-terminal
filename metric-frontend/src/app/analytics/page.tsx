"use client";

import { useState, useEffect, Suspense } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSearchParams } from "next/navigation";
import { WalletButton } from "@/components/shared/WalletButton";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { PnlChart } from "@/components/analytics/PnlChart";
import { TradeStats } from "@/components/analytics/TradeStats";
import { MarketBreakdown } from "@/components/analytics/MarketBreakdown";
import { DrawdownChart } from "@/components/analytics/DrawdownChart";
import { CollateralTimeline } from "@/components/analytics/CollateralTimeline";
import { FundingChart } from "@/components/analytics/FundingChart";
import { TradeJournal } from "@/components/analytics/TradeJournal";
import { PnlCalendar } from "@/components/analytics/PnlCalendar";
import { PnlDistribution } from "@/components/analytics/PnlDistribution";
import { ActivityByHour } from "@/components/analytics/ActivityByHour";
import { ExposureChart } from "@/components/accounts/ExposureChart";
import { FundingLog } from "@/components/accounts/FundingLog";
import { OrderHistory } from "@/components/accounts/OrderHistory";
import { TransferCollateral } from "@/components/accounts/TransferCollateral";
import Link from "next/link";
import clsx from "clsx";

const ACCESS_KEY = "ember-access";

type Tab = "performance" | "positions" | "orders" | "funding" | "trades";

interface SubaccountData {
  traderSubaccountIndex: number;
  effectiveCollateral: any;
  portfolioValue: any;
  unrealizedPnl: any;
  initialMargin: any;
  maintenanceMargin: any;
  riskState: string;
  positions: any[];
  limitOrders: Record<string, any[]>;
}

function sdkNum(val: any): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val) || 0;
  if (typeof val === "object" && val.ui != null) return parseFloat(val.ui) || 0;
  return 0;
}

function isEmptyAccount(account: SubaccountData): boolean {
  return (
    sdkNum(account.effectiveCollateral) === 0 &&
    sdkNum(account.portfolioValue) === 0 &&
    (account.positions || []).length === 0 &&
    Object.values(account.limitOrders || {}).reduce((s, o) => s + (o as any[]).length, 0) === 0
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-metric-bg">
        <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">Loading...</span>
      </div>
    }>
      <AnalyticsContent />
    </Suspense>
  );
}

/* ────────────────────────── Subaccount Components ────────────────────────── */

function MarginBar({ usage }: { usage: number }) {
  const clampedUsage = Math.min(Math.max(usage, 0), 100);
  const barColor =
    clampedUsage > 80 ? "bg-metric-sell" : clampedUsage > 50 ? "bg-yellow-500" : "bg-metric-buy";
  return (
    <div className="h-1.5 w-full bg-surface-2 overflow-hidden">
      <div className={clsx("h-full transition-all duration-500", barColor)} style={{ width: `${clampedUsage}%` }} />
    </div>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface-1 px-4 py-2.5">
      <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">{label}</span>
      <span className={clsx("font-mono text-xs tabular-nums", color || "text-text-primary")}>{value}</span>
    </div>
  );
}

function SubaccountCard({ account }: { account: SubaccountData }) {
  const idx = account.traderSubaccountIndex ?? 0;
  const isIsolated = idx > 0;
  const collateral = sdkNum(account.effectiveCollateral);
  const portfolio = sdkNum(account.portfolioValue);
  const pnl = sdkNum(account.unrealizedPnl);
  const initMargin = sdkNum(account.initialMargin);
  const positionCount = (account.positions || []).length;
  const orderCount = Object.values(account.limitOrders || {}).reduce((s, orders) => s + (orders as any[]).length, 0);
  const marginUsage = collateral > 0 ? (initMargin / collateral) * 100 : 0;

  return (
    <div className="border border-metric-border bg-surface-1">
      <div className="flex items-center justify-between border-b border-metric-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className={clsx("font-mono text-xs font-medium", isIsolated ? "text-metric-primary" : "text-text-primary")}>
            {isIsolated ? `Isolated #${idx}` : "Cross Margin"}
          </span>
          <span className={clsx("px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider", isIsolated ? "bg-metric-primary/10 text-metric-primary" : "bg-metric-buy/10 text-metric-buy")}>
            {isIsolated ? "isolated" : "cross"}
          </span>
        </div>
        <span className={clsx("font-mono text-[10px] uppercase tracking-wider", account.riskState === "Active" ? "text-metric-buy" : account.riskState === "Warning" ? "text-yellow-500" : "text-text-secondary/40")}>
          {account.riskState || "—"}
        </span>
      </div>
      <MarginBar usage={marginUsage} />
      <div className="grid grid-cols-2 gap-px bg-metric-border/40 sm:grid-cols-3">
        <StatCell label="Collateral" value={formatUsd(collateral)} />
        <StatCell label="Portfolio" value={formatUsd(portfolio)} />
        <StatCell label="Unrealized PnL" value={`${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}`} color={pnl >= 0 ? "text-metric-buy" : "text-metric-sell"} />
        <StatCell label="Margin Usage" value={`${marginUsage.toFixed(1)}%`} color={marginUsage > 80 ? "text-metric-sell" : marginUsage > 50 ? "text-yellow-500" : "text-text-primary"} />
        <StatCell label="Positions" value={positionCount.toString()} />
        <StatCell label="Open Orders" value={orderCount.toString()} />
      </div>
      {positionCount > 0 && (
        <div className="border-t border-metric-border/40">
          <div className="px-4 py-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/40">Positions</span>
          </div>
          {(account.positions || []).map((pos: any, i: number) => {
            const size = sdkNum(pos.positionSize);
            const side = size >= 0 ? "Long" : "Short";
            const entry = sdkNum(pos.entryPrice);
            const upnl = sdkNum(pos.unrealizedPnl);
            const symbol = pos.marketSymbol || pos.symbol || "?";
            return (
              <div key={`${symbol}-${i}`} className="flex items-center justify-between border-t border-metric-border/20 px-4 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-text-primary">{symbol}</span>
                  <span className={clsx("font-mono text-[10px]", side === "Long" ? "text-metric-buy" : "text-metric-sell")}>
                    {side} {Math.abs(size).toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-text-secondary">@ {formatUsd(entry)}</span>
                  <span className={clsx("font-mono text-[10px] tabular-nums", upnl >= 0 ? "text-metric-buy" : "text-metric-sell")}>
                    {upnl >= 0 ? "+" : ""}{formatUsd(upnl)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptySubaccountRow({ account }: { account: SubaccountData }) {
  const idx = account.traderSubaccountIndex ?? 0;
  return (
    <div className="flex items-center justify-between border border-metric-border/40 bg-surface-1/50 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-metric-primary/60">Isolated #{idx}</span>
        <span className="px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider bg-metric-border/30 text-text-secondary/40">empty</span>
      </div>
      <span className="font-mono text-[10px] text-text-secondary/30">$0.00</span>
    </div>
  );
}

/* ────────────────────────── Main Content ────────────────────────── */

function AnalyticsContent() {
  const { publicKey } = useWallet();
  const searchParams = useSearchParams();
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("performance");
  const [accounts, setAccounts] = useState<SubaccountData[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [showTransfer, setShowTransfer] = useState(false);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(ACCESS_KEY) === "1");
    setChecked(true);
  }, []);

  const traderParam = searchParams.get("trader");
  const authority = traderParam || publicKey?.toBase58();
  const isViewingOther = !!traderParam && traderParam !== publicKey?.toBase58();
  const isOwnProfile = !isViewingOther;

  // Fetch accounts data for positions tab
  useEffect(() => {
    if (!authed || !authority) return;
    setAccountsLoading(true);
    api
      .getTrader(authority)
      .then((res: any) => setAccounts(res.accounts || []))
      .catch(() => setAccounts([]))
      .finally(() => setAccountsLoading(false));
  }, [authed, authority]);

  if (!checked) return null;

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-metric-bg">
        <div className="flex flex-col items-center gap-4">
          <span className="font-mono text-sm text-text-secondary">Access required</span>
          <Link href="/terminal" className="font-mono text-[11px] text-metric-primary hover:underline">Go to Terminal</Link>
        </div>
      </div>
    );
  }

  const sorted = [...accounts].sort((a, b) => (a.traderSubaccountIndex ?? 0) - (b.traderSubaccountIndex ?? 0));
  const activeAccounts = sorted.filter((a) => !isEmptyAccount(a));
  const emptyAccounts = sorted.filter((a) => isEmptyAccount(a));
  const hasPositions = activeAccounts.some((a) => (a.positions || []).length > 0);
  const subaccountOptions = sorted.map((a) => ({
    index: a.traderSubaccountIndex ?? 0,
    label: (a.traderSubaccountIndex ?? 0) === 0 ? "Cross Margin" : `Isolated #${a.traderSubaccountIndex}`,
    collateral: sdkNum(a.effectiveCollateral),
  }));

  const TABS: { key: Tab; label: string }[] = [
    { key: "performance", label: "Performance" },
    { key: "positions", label: "Positions" },
    { key: "orders", label: "Orders" },
    { key: "trades", label: "Trades" },
    { key: "funding", label: "Funding" },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-metric-bg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-metric-border bg-surface-1 px-4 py-2">
        <div className="flex items-center gap-4">
          <Link href="/terminal" className="flex items-center gap-2 group">
            <div className="h-2 w-2 bg-metric-primary" style={{ boxShadow: "0 0 8px rgba(14,165,233,0.4)" }} />
            <span className="font-mono text-[11px] tracking-[0.2em] text-text-secondary/70 uppercase group-hover:text-text-primary transition-colors">
              Ember
            </span>
          </Link>
          <div className="h-4 w-px bg-metric-border" />
          <span className="font-mono text-xs font-medium text-text-primary uppercase tracking-wider">
            Profile
          </span>
          {isViewingOther && authority && (
            <>
              <div className="h-4 w-px bg-metric-border" />
              <span className="font-mono text-[10px] text-metric-primary">{truncateAddress(authority)}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Link href="/terminal" className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-metric-primary transition-colors">
            Terminal
          </Link>
          <WalletButton />
        </div>
      </div>

      {/* Content */}
      {!authority ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <span className="font-mono text-sm text-text-secondary">Connect wallet to view profile</span>
            <WalletButton />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          {/* Tab bar */}
          <div className="flex border-b border-metric-border bg-surface-1/50 px-4 overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={clsx(
                  "px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider transition-colors whitespace-nowrap",
                  activeTab === tab.key
                    ? "border-b-2 border-metric-primary text-text-primary"
                    : "text-text-secondary/50 hover:text-text-secondary"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 p-4">

            {/* ── Performance Tab ── */}
            {activeTab === "performance" && (
              <div className="flex flex-col gap-4">
                <TradeStats authority={authority} />
                <PnlCalendar authority={authority} />
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" style={{ minHeight: 300 }}>
                  <div className="border border-metric-border bg-surface-1">
                    <PnlChart authority={authority} />
                  </div>
                  <div className="border border-metric-border bg-surface-1">
                    <DrawdownChart authority={authority} />
                  </div>
                </div>
                <FundingChart authority={authority} />
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <ActivityByHour authority={authority} />
                  <PnlDistribution authority={authority} />
                </div>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div>
                    <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">Market Breakdown</h2>
                    <MarketBreakdown authority={authority} />
                  </div>
                  <div>
                    <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">Collateral History</h2>
                    <div className="max-h-80 overflow-y-auto border border-metric-border bg-surface-1">
                      <CollateralTimeline authority={authority} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Positions Tab ── */}
            {activeTab === "positions" && (
              <div className="flex flex-col gap-3">
                {accountsLoading ? (
                  <div className="flex items-center justify-center py-16">
                    <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">Loading accounts...</span>
                  </div>
                ) : accounts.length === 0 ? (
                  <div className="flex items-center justify-center py-16">
                    <span className="font-mono text-[10px] text-text-secondary/40">No accounts found</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
                        {accounts.length} subaccount{accounts.length !== 1 ? "s" : ""}
                        {emptyAccounts.length > 0 && <span className="text-text-secondary/30"> ({emptyAccounts.length} empty)</span>}
                      </span>
                      {isOwnProfile && accounts.length >= 2 && (
                        <button
                          onClick={() => setShowTransfer(true)}
                          className="px-3 py-1 border border-metric-primary/40 font-mono text-[10px] uppercase tracking-wider text-metric-primary hover:bg-metric-primary/10 transition-colors"
                        >
                          Transfer
                        </button>
                      )}
                    </div>
                    {activeAccounts.length > 0 && (
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        {activeAccounts.map((acct) => (
                          <SubaccountCard key={acct.traderSubaccountIndex ?? 0} account={acct} />
                        ))}
                      </div>
                    )}
                    {emptyAccounts.length > 0 && (
                      <div className="flex flex-col gap-1">
                        {emptyAccounts.map((acct) => (
                          <EmptySubaccountRow key={acct.traderSubaccountIndex ?? 0} account={acct} />
                        ))}
                      </div>
                    )}
                    {hasPositions && <ExposureChart authority={authority} />}
                  </>
                )}
              </div>
            )}

            {/* ── Orders Tab ── */}
            {activeTab === "orders" && <OrderHistory authority={authority} />}

            {/* ── Trades Tab ── */}
            {activeTab === "trades" && <TradeJournal authority={authority} />}

            {/* ── Funding Tab ── */}
            {activeTab === "funding" && <FundingLog authority={authority} />}
          </div>
        </div>
      )}

      {/* Transfer modal */}
      {showTransfer && (
        <TransferCollateral
          onClose={() => setShowTransfer(false)}
          subaccounts={subaccountOptions}
        />
      )}
    </div>
  );
}
