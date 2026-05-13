"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useObservability } from "@/hooks/useObservability";
import { SourceTable } from "@/components/stats/SourceTable";
import { SourceDetailTray } from "@/components/stats/SourceDetailTray";
import { WalletButton } from "@/components/shared/WalletButton";
import { loadPreferences } from "@/lib/observability/persistence";
import type { SourceCategory, SourceKind } from "@/lib/observability/types";
import clsx from "clsx";

/**
 * Kind-filter toggles available in the top bar. High-volume kinds
 * (orderbook, trades, candles) default OFF so opening /stats doesn't
 * immediately render 100+ rows. The user flips them on as needed.
 */
const TOGGLEABLE_KINDS: Array<{ kind: SourceKind; label: string; tooltip: string; defaultHidden: boolean }> = [
  { kind: "phoenix-ws-market",     label: "Market",     tooltip: "Phoenix WS market channel — oracle, mark, mid, funding, OI, volume per symbol.",                       defaultHidden: false },
  { kind: "phoenix-ws-all-mids",   label: "All mids",   tooltip: "Phoenix WS allMids channel — every market's mid price in a single message. Global heartbeat.",          defaultHidden: false },
  { kind: "phoenix-ws-funding",    label: "Funding",    tooltip: "Phoenix WS fundingRate channel — per-market funding updates. Very low frequency.",                      defaultHidden: false },
  { kind: "phoenix-ws-orderbook",  label: "Orderbook",  tooltip: "Phoenix WS orderbook channel — L2 book snapshots. HIGH VOLUME. Off by default to keep the table sane.", defaultHidden: true  },
  { kind: "phoenix-ws-trades",     label: "Trades",     tooltip: "Phoenix WS trades channel — fill prints per market.",                                                   defaultHidden: true  },
  { kind: "phoenix-ws-candles",    label: "Candles 1m", tooltip: "Phoenix WS candles channel — 1m OHLC.",                                                                 defaultHidden: true  },
];

/**
 * Observability page — internal developer dashboard for every data feed
 * the Ember Terminal touches.
 *
 * The hook (useObservability) owns connections, polling, stats, and
 * persistence. This page is purely presentational: header summary,
 * filter bar, grouped source table, slide-out detail tray with code
 * snippets.
 */
export default function StatsPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<SourceCategory, boolean>>({
    "phoenix-ws": true,
    "phoenix-rest": true,
    "ember-ws": true,
    "ember-rest": true,
  });
  const [snippetLang, setSnippetLang] = useState<string>("ts");
  const [hiddenKinds, setHiddenKinds] = useState<Set<SourceKind>>(() => {
    const initial = new Set<SourceKind>();
    for (const k of TOGGLEABLE_KINDS) if (k.defaultHidden) initial.add(k.kind);
    return initial;
  });
  const toggleKind = useCallback((kind: SourceKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }, []);

  // Hydrate UI preferences from localStorage on mount.
  useEffect(() => {
    const prefs = loadPreferences();
    setPaused(prefs.paused);
    setSelectedId(prefs.selectedSourceId);
    setSnippetLang(prefs.snippetLanguage);
    setExpanded({
      "phoenix-ws":   prefs.expandedCategories["phoenix-ws"]   ?? true,
      "phoenix-rest": prefs.expandedCategories["phoenix-rest"] ?? true,
      "ember-ws":     prefs.expandedCategories["ember-ws"]     ?? true,
      "ember-rest":   prefs.expandedCategories["ember-rest"]   ?? true,
    });
  }, []);

  // Pull market list (also auto-refreshed by the hook every 5 min via the
  // ember-rest-markets poller; this initial fetch just seeds subscriptions
  // immediately).
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const markets = await api.getMarkets();
        if (cancelled) return;
        const syms = (markets as Array<{ symbol: string }>).map((m) => m.symbol);
        setSymbols((prev) => {
          // Avoid unnecessary state churn if list is unchanged.
          if (prev.length === syms.length && prev.every((s, i) => s === syms[i])) return prev;
          return syms;
        });
      } catch (e: any) {
        if (!cancelled) setMarketsError(String(e?.message ?? e));
      }
    };
    refresh();
    const id = setInterval(refresh, 5 * 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Subscribe to exactly the kinds the user has enabled via the chips.
  // Subscribing to disabled kinds (especially the high-volume orderbook /
  // trades / candles streams) congests the single Phoenix WebSocket and
  // inflates the perceived inter-arrival gap of the channels we ARE
  // showing — so disabled = unsubscribed, not just hidden.
  const enabledPhoenixKinds = useMemo(() => {
    const enabled = new Set<SourceKind>();
    for (const t of TOGGLEABLE_KINDS) {
      if (!hiddenKinds.has(t.kind)) enabled.add(t.kind);
    }
    return enabled;
  }, [hiddenKinds]);

  const { snapshot, sources, resetAll } = useObservability({ symbols, paused, enabledPhoenixKinds });

  const selectedSource = useMemo(
    () => (selectedId ? snapshot.sources[selectedId] ?? null : null),
    [selectedId, snapshot.sources],
  );

  // Sibling sources for the channel-switcher: all Phoenix WS sources
  // sharing the selected source's symbol. Returns the selected one
  // included (so the switcher can highlight it as active). Empty when
  // the selected source isn't part of a multi-channel merged row
  // (e.g. allMids, REST endpoints).
  const selectedSiblings = useMemo<typeof sources>(() => {
    if (!selectedSource) return [];
    if (selectedSource.category !== "phoenix-ws") return [];
    if (!selectedSource.symbol) return [];
    return sources.filter(
      (s) => s.category === "phoenix-ws" && s.symbol === selectedSource.symbol,
    );
  }, [selectedSource, sources]);

  const toggleCategory = useCallback((cat: SourceCategory) => {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-ember-black text-text-primary">
      {/* Nav header */}
      <div className="flex items-center justify-between border-b border-ember-border bg-surface-l1 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-mono text-xs font-medium uppercase tracking-wider text-ember-orange hover:text-ember-orange/80">Ember</Link>
          <div className="h-4 w-px bg-ember-border" />
          <span className="font-mono text-xs font-medium uppercase tracking-wider text-text-primary">Observability</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/terminal" className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors">Terminal</Link>
          <Link href="/profile" className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors">Profile</Link>
          <Link href="/leaderboard" className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60 hover:text-ember-orange transition-colors">Leaderboard</Link>
          <WalletButton />
        </div>
      </div>

      {/* Page header + page-level explainer */}
      <div className="flex flex-col gap-2 px-4 pt-4">
        <h1 className="font-mono text-sm uppercase tracking-wider text-text-primary">Data Source Observability</h1>
        <p className="font-mono text-[10px] leading-relaxed text-text-secondary/60 max-w-4xl">
          Live status of every data feed Ember consumes — Phoenix WebSocket streams (direct, not via our backend),
          Phoenix REST snapshots, and the ember backend&apos;s relayed channels + health endpoints. Click any row to see
          the latest payload, copy-paste code snippets for replicating in another stack, and the recent message history.
          State persists in localStorage so a refresh doesn&apos;t wipe context.
        </p>
        {marketsError && (
          <div className="border border-ember-red/40 bg-ember-red/10 px-3 py-2 font-mono text-[10px] text-ember-red">
            Failed to load market list: {marketsError}. Phoenix WS subscriptions degraded.
          </div>
        )}
      </div>

      {/* Channel toggles — let the user hide high-volume kinds so the
          table doesn't have 145 rows by default. Each toggle reflects how
          many sources of that kind exist + their visibility. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-ember-border/40 bg-surface-l1/60 px-4 py-2 mt-3">
        <span className="mr-2 font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">Channels</span>
        {TOGGLEABLE_KINDS.map((t) => {
          const total = Object.values(snapshot.sources).filter((s) => s.kind === t.kind).length;
          const isVisible = !hiddenKinds.has(t.kind);
          return (
            <button
              key={t.kind}
              onClick={() => toggleKind(t.kind)}
              title={t.tooltip + (total ? `\n${total} active source(s).` : "")}
              className={clsx(
                "border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                isVisible
                  ? "border-ember-orange/40 bg-ember-orange/10 text-ember-orange"
                  : "border-ember-border text-text-secondary/50 hover:text-text-primary",
              )}
            >
              {t.label} {total > 0 && <span className="ml-1 text-text-secondary/50">{total}</span>}
            </button>
          );
        })}
      </div>

      {/* Top bar — category health + global counters + controls */}
      <div className="flex flex-wrap items-center gap-3 border-b border-ember-border/40 bg-surface-l1 px-4 py-3">
        {/* Hide category dots when zero sources are wired in that category
            — same logic as the table itself. */}
        {snapshot.categoryHealth["phoenix-ws"].total > 0 &&   <CategoryDot cat="phoenix-ws"   stats={snapshot.categoryHealth["phoenix-ws"]}   label="Phoenix WS" />}
        {snapshot.categoryHealth["phoenix-rest"].total > 0 && <CategoryDot cat="phoenix-rest" stats={snapshot.categoryHealth["phoenix-rest"]} label="Phoenix REST" />}
        {snapshot.categoryHealth["ember-ws"].total > 0 &&     <CategoryDot cat="ember-ws"     stats={snapshot.categoryHealth["ember-ws"]}     label="Ember WS" />}
        {snapshot.categoryHealth["ember-rest"].total > 0 &&   <CategoryDot cat="ember-rest"   stats={snapshot.categoryHealth["ember-rest"]}   label="Ember REST" />}

        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-[10px] text-text-secondary/60">
            {snapshot.global.totalMessages.toLocaleString()} msgs · {snapshot.global.msgsPerSec60s.toFixed(1)}/s · uptime {Math.floor(snapshot.global.uptimeSec / 60)}m{Math.floor(snapshot.global.uptimeSec % 60).toString().padStart(2, "0")}s · reconnects {snapshot.phoenixWs.reconnects}
          </span>

          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sources…"
            className="border border-ember-border bg-ember-black/60 px-2 py-1 font-mono text-[10px] text-text-primary outline-none focus:border-ember-orange/60 w-40"
          />

          <button
            onClick={() => setPaused((p) => !p)}
            className={clsx(
              "border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
              paused
                ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20"
                : "border-ember-border text-text-secondary/70 hover:bg-surface-l2 hover:text-text-primary",
            )}
            title="Pause ingestion. The WS stays connected; new messages are dropped on the floor."
          >
            {paused ? "Resume" : "Pause"}
          </button>

          <button
            onClick={resetAll}
            className="border border-ember-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-secondary/70 hover:bg-surface-l2 hover:text-text-primary transition-colors"
            title="Reset every source's counters and history. WS connections stay up."
          >
            Reset
          </button>
        </div>
      </div>

      {/* Phoenix WS connection-error banner (helps diagnose silent CSP blocks) */}
      {snapshot.phoenixWs.state === "error" && (
        <div className="border-b border-ember-red/40 bg-ember-red/10 px-4 py-2 font-mono text-[10px] text-ember-red">
          Phoenix WS: {snapshot.phoenixWs.lastErrorMessage ?? "connection error"}
        </div>
      )}
      {snapshot.phoenixWs.state === "reconnecting" && snapshot.phoenixWs.reconnects > 3 && (
        <div className="border-b border-yellow-500/40 bg-yellow-500/10 px-4 py-2 font-mono text-[10px] text-yellow-500">
          Phoenix WS reconnecting (attempt {snapshot.phoenixWs.reconnects}). Last error: {snapshot.phoenixWs.lastErrorMessage ?? "?"}
        </div>
      )}

      {/* Source table — grouped, collapsible, filterable */}
      <div className="flex-1 p-4">
        <SourceTable
          sources={sources}
          expanded={expanded}
          onToggle={toggleCategory}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          filter={filter}
          hiddenKinds={hiddenKinds}
        />
      </div>

      {/* Slide-out detail tray */}
      <SourceDetailTray
        source={selectedSource}
        siblings={selectedSiblings}
        onSelectSibling={(id) => setSelectedId(id)}
        onClose={() => setSelectedId(null)}
        defaultLanguage={snippetLang}
        onLanguageChange={setSnippetLang}
      />
    </div>
  );
}

function CategoryDot({ cat, stats, label }: { cat: SourceCategory; stats: { healthy: number; degraded: number; stale: number; error: number; idle: number; total: number }; label: string }) {
  const allHealthy = stats.total > 0 && stats.healthy === stats.total;
  const anyBad = stats.stale > 0 || stats.error > 0;
  const dotColor = stats.total === 0 ? "bg-text-secondary/30"
    : anyBad ? "bg-ember-red"
    : stats.degraded > 0 ? "bg-yellow-500"
    : allHealthy ? "bg-ember-green"
    : "bg-text-secondary/40";
  return (
    <div className="flex items-center gap-2" title={`${label}: ${stats.healthy} healthy, ${stats.degraded} degraded, ${stats.stale + stats.error} bad, ${stats.idle} idle, ${stats.total} total`}>
      <span className={clsx("inline-block h-2 w-2 rounded-full", dotColor)} />
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">{label}</span>
      <span className="font-mono text-[10px] text-text-secondary/50">{stats.healthy}/{stats.total}</span>
      {void cat /* cat available for future per-category drill-in */}
    </div>
  );
}
