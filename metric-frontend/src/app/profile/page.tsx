"use client";

import { Suspense, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { WalletButton } from "@/components/shared/WalletButton";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { StatCards } from "@/components/profile/StatCards";
import { EquityChart } from "@/components/profile/EquityChart";
import { OpenPositions } from "@/components/profile/OpenPositions";
import { MarketBreakdownGrid } from "@/components/profile/MarketBreakdownGrid";
import { HistoryTabs } from "@/components/profile/HistoryTabs";
import { ProfileDetailPanel } from "@/components/profile/ProfileDetailPanel";
import type { Period } from "@/lib/tradeStats";

export default function ProfilePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-metric-bg">
          <span className="font-mono text-[10px] text-text-secondary/40 animate-pulse">Loading…</span>
        </div>
      }
    >
      <ProfileContent />
    </Suspense>
  );
}

function ProfileContent() {
  const { publicKey, connected } = useWallet();
  const params = useSearchParams();
  const traderParam = params.get("trader");
  const authority = traderParam || publicKey?.toBase58() || null;
  const viewingOther = !!traderParam && traderParam !== publicKey?.toBase58();
  const [period, setPeriod] = useState<Period>("7d");

  if (!authority) {
    return <DisconnectedState />;
  }

  return (
    <div className="min-h-screen bg-metric-bg pb-16">
      <TopNav />

      <div className="mx-auto max-w-[1400px] px-4 pt-4">
        <ProfileHeader
          authority={authority}
          viewingOther={viewingOther}
          period={period}
          onPeriodChange={setPeriod}
        />

        <div className="mt-4">
          <StatCards authority={authority} period={period} />
        </div>

        <div className="mt-4">
          <EquityChart authority={authority} period={period} />
        </div>

        <div className="mt-4">
          <OpenPositions authority={authority} />
        </div>

        <div className="mt-4">
          <MarketBreakdownGrid authority={authority} period={period} />
        </div>

        <div className="mt-4">
          <HistoryTabs authority={authority} period={period} />
        </div>
      </div>

      <ProfileDetailPanel />
    </div>
  );
}

function TopNav() {
  return (
    <div className="flex items-center justify-between border-b border-metric-border bg-surface-1 px-4 py-2">
      <div className="flex items-center gap-4">
        <Link
          href="/terminal"
          className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 transition-colors hover:text-text-secondary"
        >
          Terminal
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-wider text-metric-primary">
          Profile
        </span>
      </div>
      <WalletButton />
    </div>
  );
}

function DisconnectedState() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-metric-bg px-4">
      <h1 className="font-mono text-sm uppercase tracking-wider text-text-primary">Profile</h1>
      <p className="font-mono text-[11px] text-text-secondary/60">
        Connect a wallet to see your trading profile, or pass <span className="text-metric-primary">?trader=&lt;pubkey&gt;</span> to view someone else&apos;s.
      </p>
      <WalletButton />
      <Link
        href="/terminal"
        className="mt-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 transition-colors hover:text-text-secondary"
      >
        ← Terminal
      </Link>
    </div>
  );
}
