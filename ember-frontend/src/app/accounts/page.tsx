"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/shared/WalletButton";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import Link from "next/link";
import clsx from "clsx";

const ACCESS_KEY = "ember-access";

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

function SubaccountCard({ account }: { account: SubaccountData }) {
  const idx = account.traderSubaccountIndex ?? 0;
  const isIsolated = idx > 0;
  const collateral = sdkNum(account.effectiveCollateral);
  const portfolio = sdkNum(account.portfolioValue);
  const pnl = sdkNum(account.unrealizedPnl);
  const initMargin = sdkNum(account.initialMargin);
  const maintMargin = sdkNum(account.maintenanceMargin);
  const positionCount = (account.positions || []).length;
  const orderCount = Object.values(account.limitOrders || {}).reduce(
    (s, orders) => s + (orders as any[]).length,
    0
  );
  const marginUsage = collateral > 0 ? (initMargin / collateral) * 100 : 0;

  return (
    <div className="border border-ember-border bg-surface-l1">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-ember-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              "font-mono text-xs font-medium",
              isIsolated ? "text-ember-orange" : "text-text-primary"
            )}
          >
            {isIsolated ? `Isolated #${idx}` : "Cross Margin"}
          </span>
          <span
            className={clsx(
              "px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
              isIsolated
                ? "bg-ember-orange/10 text-ember-orange"
                : "bg-ember-green/10 text-ember-green"
            )}
          >
            {isIsolated ? "isolated" : "cross"}
          </span>
        </div>
        <span
          className={clsx(
            "font-mono text-[10px] uppercase tracking-wider",
            account.riskState === "Active"
              ? "text-ember-green"
              : account.riskState === "Warning"
              ? "text-yellow-500"
              : "text-text-secondary/40"
          )}
        >
          {account.riskState || "—"}
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-px bg-ember-border/40 sm:grid-cols-3">
        <StatCell label="Collateral" value={formatUsd(collateral)} />
        <StatCell label="Portfolio" value={formatUsd(portfolio)} />
        <StatCell
          label="Unrealized PnL"
          value={`${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}`}
          color={pnl >= 0 ? "text-ember-green" : "text-ember-red"}
        />
        <StatCell
          label="Margin Usage"
          value={`${marginUsage.toFixed(1)}%`}
          color={
            marginUsage > 80
              ? "text-ember-red"
              : marginUsage > 50
              ? "text-yellow-500"
              : "text-text-primary"
          }
        />
        <StatCell label="Positions" value={positionCount.toString()} />
        <StatCell label="Open Orders" value={orderCount.toString()} />
      </div>

      {/* Positions list */}
      {positionCount > 0 && (
        <div className="border-t border-ember-border/40">
          <div className="px-4 py-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/40">
              Positions
            </span>
          </div>
          {(account.positions || []).map((pos: any, i: number) => {
            const size = sdkNum(pos.positionSize);
            const side = size >= 0 ? "Long" : "Short";
            const entry = sdkNum(pos.entryPrice);
            const upnl = sdkNum(pos.unrealizedPnl);
            const symbol = pos.marketSymbol || pos.symbol || "?";

            return (
              <div
                key={`${symbol}-${i}`}
                className="flex items-center justify-between border-t border-ember-border/20 px-4 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-text-primary">{symbol}</span>
                  <span
                    className={clsx(
                      "font-mono text-[10px]",
                      side === "Long" ? "text-ember-green" : "text-ember-red"
                    )}
                  >
                    {side} {Math.abs(size).toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-text-secondary">
                    @ {formatUsd(entry)}
                  </span>
                  <span
                    className={clsx(
                      "font-mono text-[10px] tabular-nums",
                      upnl >= 0 ? "text-ember-green" : "text-ember-red"
                    )}
                  >
                    {upnl >= 0 ? "+" : ""}
                    {formatUsd(upnl)}
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

function StatCell({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface-l1 px-4 py-2.5">
      <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">
        {label}
      </span>
      <span className={clsx("font-mono text-xs tabular-nums", color || "text-text-primary")}>
        {value}
      </span>
    </div>
  );
}

export default function AccountsPage() {
  const { publicKey } = useWallet();
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [accounts, setAccounts] = useState<SubaccountData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(ACCESS_KEY) === "1");
    setChecked(true);
  }, []);

  const authority = publicKey?.toBase58();

  useEffect(() => {
    if (!authed || !authority) return;
    setLoading(true);
    api
      .getTrader(authority)
      .then((res: any) => {
        setAccounts(res.accounts || []);
      })
      .catch(() => setAccounts([]))
      .finally(() => setLoading(false));
  }, [authed, authority]);

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
            Accounts
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
            Analytics
          </Link>
          <WalletButton />
        </div>
      </div>

      {/* Content */}
      {!authority ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <span className="font-mono text-sm text-text-secondary">
              Connect wallet to view accounts
            </span>
            <WalletButton />
          </div>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">
            Loading accounts...
          </span>
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="font-mono text-sm text-text-secondary/40">No accounts found</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              {accounts.length} subaccount{accounts.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {accounts
              .sort((a, b) => (a.traderSubaccountIndex ?? 0) - (b.traderSubaccountIndex ?? 0))
              .map((acct) => (
                <SubaccountCard
                  key={acct.traderSubaccountIndex ?? 0}
                  account={acct}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
