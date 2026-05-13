"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { DataSource } from "@/lib/observability/types";
import { generateSnippets } from "@/lib/observability/snippets";
import { CodeBlock } from "./CodeBlock";
import clsx from "clsx";

interface Props {
  source: DataSource | null;
  onClose: () => void;
  defaultLanguage?: string;
  onLanguageChange?: (lang: string) => void;
}

function fmtMs(v: number | null): string {
  if (v == null) return "—";
  if (v < 1000) return `${v.toFixed(0)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(2)}s`;
  return `${(v / 60_000).toFixed(2)}m`;
}

function fmtAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.floor(sec % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h`;
}

/**
 * Slide-out detail panel. Click a source row → this opens on the right
 * with full payload, code snippets in your preferred language, and the
 * recent-history scrollback.
 */
export function SourceDetailTray({ source, onClose, defaultLanguage, onLanguageChange }: Props) {
  // Escape closes the tray.
  useEffect(() => {
    if (!source) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [source, onClose]);

  return (
    <AnimatePresence>
      {source && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-[90] bg-black/40"
          />
          <motion.div
            key={source.id}
            initial={{ x: 540 }} animate={{ x: 0 }} exit={{ x: 540 }}
            transition={{ type: "spring", damping: 32, stiffness: 320 }}
            className="fixed right-0 top-0 bottom-0 z-[91] w-[540px] border-l border-ember-border bg-surface-l1 shadow-[−24px_0_96px_rgba(0,0,0,0.55)] overflow-y-auto"
          >
            <Header source={source} onClose={onClose} />
            <Body source={source} defaultLanguage={defaultLanguage} onLanguageChange={onLanguageChange} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Header({ source, onClose }: { source: DataSource; onClose: () => void }) {
  const ss = statusBadge(source.status);
  return (
    <div className="border-b border-ember-border/70 px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ember-orange">{source.kind}</span>
          <h2 className="font-mono text-sm uppercase tracking-wider text-text-primary">{source.label}</h2>
          <code className="font-mono text-[10px] text-text-secondary/50">{source.endpoint}</code>
        </div>
        <button onClick={onClose} className="text-text-secondary/60 hover:text-text-primary transition-colors">
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={clsx("inline-block h-2 w-2 rounded-full", ss.dot)} />
        <span className={clsx("font-mono text-[10px] uppercase tracking-wider", ss.cls)}>{ss.label}</span>
        <span className="ml-2 font-mono text-[10px] text-text-secondary/50">last {fmtAge(source.stats.ageSec)} ago · {source.stats.count.toLocaleString()} total</span>
      </div>
    </div>
  );
}

function Body({ source, defaultLanguage, onLanguageChange }: { source: DataSource; defaultLanguage?: string; onLanguageChange?: (lang: string) => void }) {
  const snippets = generateSnippets(source);
  const [tab, setTab] = useState<"payload" | "history" | "code">("code");

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* Description */}
      <p className="font-mono text-[10px] leading-relaxed text-text-secondary/70">{source.description}</p>

      {/* Stats summary */}
      <div className="grid grid-cols-3 gap-2">
        <StatBox label="p50" value={fmtMs(source.stats.p50Ms)} />
        <StatBox label="p95" value={fmtMs(source.stats.p95Ms)} highlight />
        <StatBox label="p99" value={fmtMs(source.stats.p99Ms)} />
        <StatBox label="max gap" value={fmtMs(source.stats.maxMs)} />
        <StatBox label="rate (60s)" value={`${source.stats.rate60s.toFixed(2)}/s`} />
        <StatBox label="errors" value={source.stats.errorCount.toString()} dim={source.stats.errorCount === 0} />
      </div>

      {/* Tabs */}
      <div className="flex border border-ember-border bg-surface-l2/40">
        {(["code", "payload", "history"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={clsx(
              "flex-1 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors border-r border-ember-border/40 last:border-r-0",
              tab === k ? "bg-ember-orange/10 text-ember-orange" : "text-text-secondary/60 hover:text-text-primary",
            )}
          >
            {k}
          </button>
        ))}
      </div>

      {tab === "code" && <CodeBlock snippets={snippets} defaultLanguage={defaultLanguage} onLanguageChange={onLanguageChange} />}
      {tab === "payload" && (
        <div className="border border-ember-border bg-surface-l2/40">
          <div className="border-b border-ember-border/50 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
            Latest payload
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-[10px] leading-relaxed text-text-primary/90 whitespace-pre">{source.latestPayload ? JSON.stringify(source.latestPayload, null, 2) : "(none)"}</pre>
        </div>
      )}
      {tab === "history" && (
        <div className="border border-ember-border bg-surface-l2/40 max-h-[60vh] overflow-y-auto">
          <div className="border-b border-ember-border/50 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
            Recent {source.recentPayloads.length} payloads (newest first)
          </div>
          <div className="flex flex-col">
            {[...source.recentPayloads].reverse().map((entry, i) => (
              <div key={i} className="border-b border-ember-border/20 px-3 py-1.5 font-mono text-[9px] text-text-secondary/70">
                <div className="text-text-secondary/40">t = {(entry.tMs / 1000).toFixed(3)}s</div>
                <div className="truncate text-text-primary/80" title={JSON.stringify(entry.payload)}>
                  {JSON.stringify(entry.payload).slice(0, 180)}
                </div>
              </div>
            ))}
            {source.recentPayloads.length === 0 && (
              <div className="px-3 py-3 font-mono text-[10px] text-text-secondary/40">No payloads received yet.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, highlight, dim }: { label: string; value: string; highlight?: boolean; dim?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border border-ember-border/60 bg-surface-l2/40 px-2 py-1.5">
      <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/50">{label}</span>
      <span className={clsx("font-mono text-xs", highlight ? "text-ember-orange" : dim ? "text-text-secondary/40" : "text-text-primary")}>{value}</span>
    </div>
  );
}

function statusBadge(s: DataSource["status"]) {
  switch (s) {
    case "healthy":  return { label: "Healthy",  cls: "text-ember-green",       dot: "bg-ember-green" };
    case "degraded": return { label: "Degraded", cls: "text-yellow-500",        dot: "bg-yellow-500" };
    case "stale":    return { label: "Stale",    cls: "text-ember-red",         dot: "bg-ember-red" };
    case "error":    return { label: "Error",    cls: "text-ember-red",         dot: "bg-ember-red" };
    case "idle":     return { label: "Idle",     cls: "text-text-secondary/50", dot: "bg-text-secondary/30" };
  }
}
