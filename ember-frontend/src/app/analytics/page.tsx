"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSearchParams } from "next/navigation";
import { WalletButton } from "@/components/shared/WalletButton";
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
import Link from "next/link";

const ACCESS_KEY = "ember-access";

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function AnalyticsPage() {
  const { publicKey } = useWallet();
  const searchParams = useSearchParams();
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(ACCESS_KEY) === "1");
    setChecked(true);
  }, []);

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

  // Support viewing any trader via ?trader=PUBKEY query param
  const traderParam = searchParams.get("trader");
  const authority = traderParam || publicKey?.toBase58();
  const isViewingOther = !!traderParam && traderParam !== publicKey?.toBase58();

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
            Analytics
          </span>
          {isViewingOther && authority && (
            <>
              <div className="h-4 w-px bg-ember-border" />
              <span className="font-mono text-[10px] text-ember-orange">
                {truncateAddress(authority)}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/terminal"
            className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors"
          >
            Terminal
          </Link>
          <Link
            href="/leaderboard"
            className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors"
          >
            Leaderboard
          </Link>
          <WalletButton />
        </div>
      </div>

      {/* Content */}
      {!authority ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <span className="font-mono text-sm text-text-secondary">
              Connect wallet to view analytics
            </span>
            <WalletButton />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4 p-4">
          {/* Trade Stats */}
          <section>
            <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              Performance Overview
            </h2>
            <TradeStats authority={authority} />
          </section>

          {/* PnL Calendar */}
          <section>
            <PnlCalendar authority={authority} />
          </section>

          {/* Charts row: PnL + Drawdown */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" style={{ minHeight: 320 }}>
            <section className="border border-ember-border bg-surface-l1">
              <PnlChart authority={authority} />
            </section>
            <section className="border border-ember-border bg-surface-l1">
              <DrawdownChart authority={authority} />
            </section>
          </div>

          {/* Funding & Fees Chart */}
          <section style={{ minHeight: 260 }}>
            <FundingChart authority={authority} />
          </section>

          {/* Activity + Distribution row */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section>
              <ActivityByHour authority={authority} />
            </section>
            <section>
              <PnlDistribution authority={authority} />
            </section>
          </div>

          {/* Market Breakdown + Collateral Timeline */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
                Market Breakdown
              </h2>
              <MarketBreakdown authority={authority} />
            </section>

            <section>
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
                Collateral History
              </h2>
              <div className="max-h-80 overflow-y-auto border border-ember-border bg-surface-l1">
                <CollateralTimeline authority={authority} />
              </div>
            </section>
          </div>

          {/* Trade Journal */}
          <section>
            <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
              Trade Journal
            </h2>
            <TradeJournal authority={authority} />
          </section>
        </div>
      )}
    </div>
  );
}
