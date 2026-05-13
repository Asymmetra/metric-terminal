"use client";

import type { DataSource, SourceCategory, SourceStatus } from "@/lib/observability/types";
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
  if (typeof p === "object") {
    if (typeof p.oraclePx === "number") return `oracle $${formatPrice(p.oraclePx)}`;
    if (typeof p.mids === "object") return `${Object.keys(p.mids).length} mids · slot ${p.slot}`;
    if (typeof p.funding === "number") return `funding ${(p.funding * 100).toFixed(4)}%`;
    if (Array.isArray(p)) return `[${p.length} items]`;
    const keys = Object.keys(p);
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return String(p).slice(0, 40);
}

export function SourceTable({ sources, expanded, onToggle, selectedId, onSelect, filter }: Props) {
  // Group by category.
  const groups = new Map<SourceCategory, DataSource[]>();
  const normalizedFilter = filter.trim().toLowerCase();
  for (const s of sources) {
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
                <table className="w-full min-w-[900px] font-mono text-[11px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-text-secondary/40">
                      <Th align="left">Source</Th>
                      <Th align="left">Latest</Th>
                      <Th align="right" title="Time since the last update arrived.">Last</Th>
                      <Th align="right" title="Total messages / polls since reset.">Count</Th>
                      <Th align="right" title="Approximate inter-arrival samples in the rolling window.">N/60s</Th>
                      <Th align="right" title="p50 of recent inter-arrival deltas.">p50</Th>
                      <Th align="right" title="p95 of recent inter-arrival deltas. Healthy if ≤ 500ms.">p95</Th>
                      <Th align="right" title="Worst gap seen in the window.">max</Th>
                      <Th align="left">Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((src) => {
                      const ss = statusStyles(src.status);
                      const selected = selectedId === src.id;
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
                          <td className="px-3 py-1.5 text-text-secondary/70 text-[10px] max-w-[280px] truncate" title={JSON.stringify(src.latestPayload)?.slice(0, 400)}>
                            {previewLatest(src)}
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
                No sources match the current filter.
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
