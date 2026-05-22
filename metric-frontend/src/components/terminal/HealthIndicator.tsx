"use client";

import { useEffect, useState } from "react";
import { useMarketStore } from "@/stores/marketStore";
import {
  useHealthStore,
  wsColor,
  restColor,
  overallColor,
  freshness,
  type HealthColor,
} from "@/lib/health";
import { PHOENIX_API_URL } from "@/lib/phoenix-candles";
import { IMPERIAL_API_URL } from "@/lib/imperial/config";

/**
 * Header health indicator. One overall dot + label; hover reveals every endpoint
 * the terminal consumes, with status + latency (REST) or freshness (WS).
 *
 * WS liveness is fed by the feed code (market-data → health store). REST latency
 * is measured here by a periodic timed `fetch`.
 */

const REST_POLL_MS = 20_000;

function dotClass(c: HealthColor): string {
  return c === "ok"
    ? "bg-metric-buy"
    : c === "warn"
    ? "bg-yellow-400"
    : c === "down"
    ? "bg-metric-sell"
    : "bg-text-secondary/40";
}

async function timedFetch(url: string): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store" });
    return { ok: res.ok, latencyMs: Math.round(performance.now() - t0), status: res.status };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), status: 0 };
  }
}

export function HealthIndicator() {
  const symbol = useMarketStore((s) => s.selectedSymbol);
  const ws = useHealthStore((s) => s.ws);
  const rest = useHealthStore((s) => s.rest);
  const noteRest = useHealthStore((s) => s.noteRest);
  const [open, setOpen] = useState(false);
  // 1s tick so WS freshness/age recomputes even without new messages.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // REST pollers: time a real request to each endpoint, store latency + ok.
  useEffect(() => {
    let cancelled = false;
    const sym = symbol || "SOL";
    async function poll() {
      const [phx, imp] = await Promise.all([
        timedFetch(`${PHOENIX_API_URL}/candles?symbol=${sym}&timeframe=1m&limit=1`),
        timedFetch(`${IMPERIAL_API_URL}/api/v1/status`),
      ]);
      if (cancelled) return;
      noteRest("phoenix-rest", {
        ok: phx.ok,
        latencyMs: phx.latencyMs,
        detail: phx.ok ? `${phx.latencyMs}ms` : `HTTP ${phx.status || "err"}`,
        checkedAt: Date.now(),
      });
      noteRest("imperial-rest", {
        ok: imp.ok,
        latencyMs: imp.latencyMs,
        detail: imp.ok ? `${imp.latencyMs}ms` : `HTTP ${imp.status || "err"}`,
        checkedAt: Date.now(),
      });
    }
    void poll();
    const id = setInterval(poll, REST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol, noteRest]);

  const phoenixWsC = wsColor(ws["phoenix-ws"], now);
  const imperialWsC = wsColor(ws["imperial-ws"], now);
  const phoenixRestC = restColor(rest["phoenix-rest"]);
  const imperialRestC = restColor(rest["imperial-rest"]);
  const overall = overallColor([phoenixWsC, imperialWsC, phoenixRestC, imperialRestC]);

  const label = overall === "ok" ? "Live" : overall === "warn" ? "Degraded" : overall === "down" ? "Down" : "…";

  const rows: { name: string; color: HealthColor; detail: string }[] = [
    { name: "phoenix-ws", color: phoenixWsC, detail: freshness(ws["phoenix-ws"].lastMessageAt, now) },
    { name: "imperial-ws", color: imperialWsC, detail: freshness(ws["imperial-ws"].lastMessageAt, now) },
    { name: "phoenix-rest", color: phoenixRestC, detail: rest["phoenix-rest"].detail ?? "—" },
    { name: "imperial-rest", color: imperialRestC, detail: rest["imperial-rest"].detail ?? "—" },
  ];

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary transition-colors hover:text-text-primary"
        aria-label={`System health: ${label}`}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass(overall)}`} aria-hidden />
        <span className="hidden sm:inline">{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 border border-metric-border bg-surface-1 p-3 shadow-xl">
          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-text-secondary/60">
            System Health
          </div>
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="w-3 py-1">
                    <span className={`inline-block h-2 w-2 rounded-full ${dotClass(r.color)}`} aria-hidden />
                  </td>
                  <td className="py-1 pr-2 text-text-primary">{r.name}</td>
                  <td className="py-1 text-right text-text-secondary">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
