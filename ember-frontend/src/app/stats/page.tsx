"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useOracleFeed } from "@/hooks/useOracleFeed";
import { ConnectionPanel } from "@/components/stats/ConnectionPanel";
import { OracleStatsTable } from "@/components/stats/OracleStatsTable";
import { WalletButton } from "@/components/shared/WalletButton";

/**
 * Phoenix oracle feed observability page.
 *
 * Connects the browser directly to `wss://perp-api.phoenix.trade/ws` (NOT
 * via the ember-backend relay) and renders live latency stats for every
 * Phoenix market's subscribe_to_market channel. Designed to validate the
 * client-direct architecture before committing to it in the React Native
 * app — see /Users/liamdig/.claude/plans/image-1-phoenix-ellpss-just-sleepy-nebula.md
 * for the architectural rationale.
 *
 * No access gate: the data shown here is already public (Phoenix's WS is
 * an open endpoint anyone can hit). Replicating the /leaderboard
 * sessionStorage gate would just create friction without adding security.
 */
export default function StatsPage() {
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [enableAllMids, setEnableAllMids] = useState(false);

  useEffect(() => {
    api
      .getMarkets()
      .then((markets: Array<{ symbol: string }>) => setSymbols(markets.map((m) => m.symbol)))
      .catch((e) => setMarketsError(String(e?.message ?? e)));
  }, []);

  const { state, exportCsv, resetStats, resubscribe } = useOracleFeed(symbols ?? [], {
    enableAllMids,
  });

  // When the allMids toggle flips at runtime, the WS is healthy already
  // so push the new subscription set immediately rather than waiting for
  // the next reconnect.
  useEffect(() => {
    if (symbols && symbols.length > 0) resubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableAllMids]);

  const rows = useMemo(() => Object.values(state.bySymbol), [state.bySymbol]);

  return (
    <div className="flex min-h-screen flex-col bg-ember-black text-text-primary">
      {/* Header — matches the existing /leaderboard layout */}
      <div className="flex items-center justify-between border-b border-ember-border bg-surface-l1 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-mono text-xs font-medium uppercase tracking-wider text-ember-orange hover:text-ember-orange/80">
            Ember
          </Link>
          <div className="h-4 w-px bg-ember-border" />
          <span className="font-mono text-xs font-medium uppercase tracking-wider text-text-primary">
            Oracle Feed Stats
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/terminal" className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors">Terminal</Link>
          <Link href="/profile" className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors">Profile</Link>
          <Link href="/leaderboard" className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors">Leaderboard</Link>
          <WalletButton />
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-mono text-sm uppercase tracking-wider text-text-primary">Phoenix Oracle Feed</h1>
          <p className="font-mono text-[10px] leading-relaxed text-text-secondary/60 max-w-3xl">
            Live latency stats for Phoenix&apos;s <code>subscribe_to_market</code> stream, connected directly from this browser to
            <code className="ml-1 text-text-secondary/80">wss://perp-api.phoenix.trade/ws</code> — not via the ember backend.
            The point of this page is to characterize what a thin client (i.e. the React Native app) will see, so reliability problems
            aren&apos;t masked by our server-side relay. Healthy means p95 inter-arrival &lt; 500ms AND last update &lt; 5s.
          </p>
        </div>

        <ConnectionPanel
          connection={state.connection}
          onExportCsv={exportCsv}
          onResetStats={resetStats}
          enableAllMids={enableAllMids}
          onToggleAllMids={setEnableAllMids}
        />

        {marketsError && (
          <div className="border border-ember-red/40 bg-ember-red/10 px-3 py-2 font-mono text-[10px] text-ember-red">
            Failed to load market list: {marketsError}
          </div>
        )}

        {!symbols && !marketsError && (
          <div className="border border-ember-border bg-surface-l1 px-3 py-2 font-mono text-[10px] text-text-secondary/60">
            Loading market list…
          </div>
        )}

        {symbols && <OracleStatsTable rows={rows} />}
      </div>
    </div>
  );
}
