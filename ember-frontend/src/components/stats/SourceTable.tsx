"use client";

import type { DataSource, SourceCategory, SourceKind, SourceStatus } from "@/lib/observability/types";
import { formatPrice } from "@/lib/format";
import clsx from "clsx";

interface Props {
  sources: DataSource[];
  /** Map of category → expanded state. */
  expanded: Record<string, boolean>;
  /** Toggle a category section open/closed. */
  onToggle: (cat: SourceCategory) => void;
  /** Currently-selected source (for tray). */
  selectedId: string | null;
  /** Click a row to open the detail tray. */
  onSelect: (id: string) => void;
  /** Search filter (matches against label + id). */
  filter: string;
  /** Set of source-kinds the user has hidden via the channel toggles. */
  hiddenKinds: Set<SourceKind>;
}

const CATEGORY_LABELS: Record<SourceCategory, string> = {
  "phoenix-ws":   "Phoenix · WebSocket",
  "phoenix-rest": "Phoenix · REST",
  "ember-ws":     "Ember Backend · WebSocket",
  "ember-rest":   "Ember Backend · REST",
};

const CATEGORY_DESC: Record<SourceCategory, string> = {
  "phoenix-ws":   "Streams from wss://perp-api.phoenix.trade/ws — direct from Phoenix's perp infrastructure. Event-driven (no fixed cadence).",
  "phoenix-rest": "REST snapshots from perp-api.phoenix.trade. Polled at our rate.",
  "ember-ws":     "Our backend's relayed streams (wss://ember-backend-q4nf.onrender.com/ws). Same data as Phoenix WS but routed through the ember relay.",
  "ember-rest":   "Our backend's HTTP API (ember-backend-q4nf.onrender.com).",
};

function fmtMs(v: number | null): string {
  if (v == null) return "—";
  if (v < 1000) return `${v.toFixed(0)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return `${(v / 60_000).toFixed(1)}m`;
}

function fmtAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.floor(sec % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h`;
}

function statusStyles(s: SourceStatus): { label: string; cls: string; dot: string } {
  switch (s) {
    case "healthy":  return { label: "Healthy",  cls: "text-ember-green",         dot: "bg-ember-green" };
    case "degraded": return { label: "Degraded", cls: "text-yellow-500",          dot: "bg-yellow-500" };
    case "stale":    return { label: "Stale",    cls: "text-ember-red",           dot: "bg-ember-red" };
    case "error":    return { label: "Error",    cls: "text-ember-red",           dot: "bg-ember-red" };
    case "idle":     return { label: "Idle",     cls: "text-text-secondary/40",   dot: "bg-text-secondary/30" };
  }
}

function previewLatest(src: DataSource): string {
  const p = src.latestPayload as any;
  if (!p) return "";
  if (typeof p !== "object") return String(p).slice(0, 40);

  // Per-kind preview format — keep the row useful at-a-glance without
  // dumping the full payload.
  switch (src.kind) {
    case "phoenix-ws-market":
      if (typeof p.oraclePx === "number" && typeof p.markPx === "number" && typeof p.midPx === "number") {
        return `O ${formatPrice(p.oraclePx)} · M ${formatPrice(p.markPx)} · m ${formatPrice(p.midPx)}`;
      }
      break;
    case "phoenix-ws-all-mids":
      return `${Object.keys(p.mids ?? {}).length} mids · slot ${p.slot ?? "?"}`;
    case "phoenix-ws-funding":
      return typeof p.funding === "number" ? `${(p.funding * 100).toFixed(4)}% per epoch` : "";
    case "phoenix-ws-orderbook": {
      const bestBid = Array.isArray(p.bids) ? p.bids[0] : null;
      const bestAsk = Array.isArray(p.asks) ? p.asks[0] : null;
      const bidPx = bestBid && typeof bestBid[0] === "number" ? bestBid[0] : null;
      const askPx = bestAsk && typeof bestAsk[0] === "number" ? bestAsk[0] : null;
      const depthBid = Array.isArray(p.bids) ? p.bids.length : 0;
      const depthAsk = Array.isArray(p.asks) ? p.asks.length : 0;
      if (bidPx && askPx) {
        const spread = ((askPx - bidPx) / askPx) * 10_000;
        return `${formatPrice(bidPx)} / ${formatPrice(askPx)} · ${spread.toFixed(1)}bp · ${depthBid}/${depthAsk}`;
      }
      return `${depthBid} bids · ${depthAsk} asks`;
    }
    case "phoenix-ws-trades": {
      const trades = Array.isArray(p.trades) ? p.trades : [];
      const last = trades[trades.length - 1];
      if (last) {
        const side = String(last.side ?? "").toLowerCase();
        const px = typeof last.px === "number" ? last.px : (typeof last.price === "number" ? last.price : null);
        const sz = typeof last.sz === "number" ? last.sz : (typeof last.size === "number" ? last.size : null);
        return `${side} ${sz != null ? sz.toFixed(4) : "?"} @ ${px != null ? formatPrice(px) : "?"} · ${trades.length} this msg`;
      }
      return `${trades.length} trades`;
    }
    case "phoenix-ws-candles": {
      const c = p.candle ?? p;
      if (typeof c?.c === "number") return `O ${c.o} H ${c.h} L ${c.l} C ${c.c}`;
      if (typeof c?.close === "number") return `O ${c.open} H ${c.high} L ${c.low} C ${c.close}`;
      return "";
    }
  }

  // Generic fallback.
  if (Array.isArray(p)) return `[${p.length} items]`;
  const keys = Object.keys(p);
  return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
}

/**
 * Return mark-oracle spread in bps if the source's latest payload has
 * the three prices, else null. Used by the table's Spread column.
 */
function computeSpreadBps(src: DataSource): { markOracleBps: number; midOracleBps: number } | null {
  const p = src.latestPayload as any;
  if (!p || typeof p !== "object") return null;
  if (typeof p.oraclePx !== "number" || p.oraclePx <= 0) return null;
  if (typeof p.markPx !== "number" || typeof p.midPx !== "number") return null;
  return {
    markOracleBps: ((p.markPx - p.oraclePx) / p.oraclePx) * 10_000,
    midOracleBps:  ((p.midPx  - p.oraclePx) / p.oraclePx) * 10_000,
  };
}

export function SourceTable({ sources, expanded, onToggle, selectedId, onSelect, filter, hiddenKinds }: Props) {
  // Group by category. Track total-before-filter so we can distinguish
  // "category is empty because we haven't wired it yet" from "category is
  // empty because the filter excluded everything".
  const groups = new Map<SourceCategory, DataSource[]>();
  const totalsByCategory = new Map<SourceCategory, number>();
  const normalizedFilter = filter.trim().toLowerCase();
  for (const s of sources) {
    totalsByCategory.set(s.category, (totalsByCategory.get(s.category) ?? 0) + 1);
    if (hiddenKinds.has(s.kind)) continue;
    if (normalizedFilter && !`${s.id} ${s.label}`.toLowerCase().includes(normalizedFilter)) continue;
    const arr = groups.get(s.category) ?? [];
    arr.push(s);
    groups.set(s.category, arr);
  }

  const categoryOrder: SourceCategory[] = ["phoenix-ws", "phoenix-rest", "ember-ws", "ember-rest"];

  return (
    <div className="flex flex-col gap-3">
      {categoryOrder.map((cat) => {
        const rows = groups.get(cat) ?? [];
        const totalRegistered = totalsByCategory.get(cat) ?? 0;
        // Hide categories that have ZERO registered sources entirely —
        // they're not wired yet, so listing them with a misleading "no
        // sources match the current filter" message is confusing.
        if (totalRegistered === 0) return null;
        const isOpen = expanded[cat] ?? true;
        const healthy = rows.filter((r) => r.status === "healthy").length;
        const degraded = rows.filter((r) => r.status === "degraded").length;
        const stale = rows.filter((r) => r.status === "stale" || r.status === "error").length;
        const total = rows.length;
        return (
          <div key={cat} className="border border-ember-border bg-surface-l1">
            <button
              onClick={() => onToggle(cat)}
              className="flex w-full items-center justify-between border-b border-ember-border/60 px-4 py-2 text-left hover:bg-surface-l2/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] text-text-secondary/50">{isOpen ? "▾" : "▸"}</span>
                <span className="font-mono text-[11px] uppercase tracking-wider text-text-primary">{CATEGORY_LABELS[cat]}</span>
                <span className="font-mono text-[10px] text-text-secondary/40">{CATEGORY_DESC[cat]}</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px]">
                <span className="text-ember-green">● {healthy}</span>
                <span className="text-yellow-500">● {degraded}</span>
                <span className="text-ember-red">● {stale}</span>
                <span className="text-text-secondary/50">{total} total</span>
              </div>
            </button>

            {isOpen && rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] font-mono text-[11px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-text-secondary/40">
                      <Th align="left">Source</Th>
                      <Th align="left">Latest</Th>
                      <Th align="right" title="Mark−Oracle spread in basis points (market sources only). Positive = mark trades above oracle.">Mark−Oracle</Th>
                      <Th align="right" title="Time since the most recent message arrived. Resets to 0 on every update; grows up to ~Gap p50 between messages. This is age-of-freshest-value, NOT a request-latency measurement.">Age</Th>
                      <Th align="right" title="Total messages or successful polls since reset.">Count</Th>
                      <Th align="right" title="Approximate count of inter-arrival samples in the rolling 60s window.">N/60s</Th>
                      <Th align="right" title="Median GAP between consecutive messages — how often the source publishes. If Phoenix publishes once per second, this will be ~1000ms even though every individual message arrives in microseconds. Different from Age.">Gap p50</Th>
                      <Th align="right" title="95th-percentile gap between consecutive messages. Healthy if ≤ 500ms for liquid markets.">Gap p95</Th>
                      <Th align="right" title="Worst gap seen in the rolling window.">Gap max</Th>
                      <Th align="left">Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((src) => {
                      const ss = statusStyles(src.status);
                      const selected = selectedId === src.id;
                      const spread = computeSpreadBps(src);
                      return (
                        <tr
                          key={src.id}
                          onClick={() => onSelect(src.id)}
                          className={clsx(
                            "cursor-pointer border-b border-ember-border/20 transition-colors",
                            selected ? "bg-ember-orange/10" : "hover:bg-surface-l2/30",
                          )}
                        >
                          <td className="px-3 py-1.5">
                            <div className="text-text-primary">{src.label}</div>
                            <div className="text-[9px] text-text-secondary/40">{src.endpoint}{src.symbol ? ` · ${src.symbol}` : ""}</div>
                          </td>
                          <td className="px-3 py-1.5 text-text-secondary/70 text-[10px] max-w-[260px] truncate" title={JSON.stringify(src.latestPayload)?.slice(0, 400)}>
                            {previewLatest(src)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono text-[10px]">
                            {spread ? (
                              <span
                                className={Math.abs(spread.markOracleBps) < 1 ? "text-text-secondary/50" : spread.markOracleBps > 0 ? "text-ember-green" : "text-ember-red"}
                                title={`Mark − Oracle: ${spread.markOracleBps > 0 ? "+" : ""}${spread.markOracleBps.toFixed(2)}bp\nMid − Oracle: ${spread.midOracleBps > 0 ? "+" : ""}${spread.midOracleBps.toFixed(2)}bp`}
                              >
                                {spread.markOracleBps > 0 ? "+" : ""}{spread.markOracleBps.toFixed(2)}bp
                              </span>
                            ) : (
                              <span className="text-text-secondary/30">—</span>
                            )}
                          </td>
                          <td className={clsx(
                            "px-3 py-1.5 text-right",
                            src.stats.ageSec == null ? "text-text-secondary/40"
                            : src.stats.ageSec < 5 ? "text-ember-green"
                            : src.stats.ageSec < 30 ? "text-yellow-500"
                            : "text-ember-red",
                          )}>
                            {fmtAge(src.stats.ageSec)}
                          </td>
                          <td className="px-3 py-1.5 text-right text-text-secondary/70">{src.stats.count.toLocaleString()}</td>
                          <td className="px-3 py-1.5 text-right text-text-secondary/60">{src.stats.count60s}</td>
                          <td className="px-3 py-1.5 text-right text-text-secondary/80">{fmtMs(src.stats.p50Ms)}</td>
                          <td className={clsx(
                            "px-3 py-1.5 text-right",
                            src.stats.p95Ms == null ? "text-text-secondary/40"
                            : src.stats.p95Ms < 500 ? "text-ember-green"
                            : src.stats.p95Ms < 2000 ? "text-yellow-500"
                            : "text-ember-red",
                          )}>{fmtMs(src.stats.p95Ms)}</td>
                          <td className="px-3 py-1.5 text-right text-text-secondary/50">{fmtMs(src.stats.maxMs)}</td>
                          <td className="px-3 py-1.5">
                            <span className="inline-flex items-center gap-1.5">
                              <span className={clsx("inline-block h-1.5 w-1.5 rounded-full", ss.dot)} />
                              <span className={clsx("text-[10px] uppercase tracking-wider", ss.cls)}>{ss.label}</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {isOpen && rows.length === 0 && (
              <div className="px-4 py-3 font-mono text-[10px] text-text-secondary/40">
                {normalizedFilter
                  ? `No sources in this category match "${filter}".`
                  : "No sources match the current filter."}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Th({ children, align = "left", title }: { children: React.ReactNode; align?: "left" | "right"; title?: string }) {
  return (
    <th className={clsx("px-3 py-1.5 font-normal", align === "right" ? "text-right" : "text-left")} title={title}>
      {title ? <span className="cursor-help border-b border-dotted border-text-secondary/30">{children}</span> : children}
    </th>
  );
}
