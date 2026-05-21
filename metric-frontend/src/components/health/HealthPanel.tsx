"use client";

import { useEffect, useMemo, useState } from "react";
import { IMPERIAL_API_URL } from "@/lib/imperial/config";

/**
 * Live health checkpoint for the Imperial pipeline.
 *
 * Metric Terminal is fully standalone (no metric-backend), so the only
 * upstreams to monitor are:
 *   imperial-rest  GET {IMPERIAL_API_URL}/api/v1/status
 *   imperial-ws    live message rate from the consuming page's WS connection
 */

type Color = "ok" | "warn" | "down" | "idle";

type Row = { label: string; color: Color; detail: string; href?: string };

interface ImperialStatus {
  db: string;
  indexer?: { status: string } | null;
  orderBot?: { status: string } | null;
}

export function HealthPanel({ wsEventsPerSecond }: { wsEventsPerSecond?: number }) {
  const [imperial, setImperial] = useState<{ data: ImperialStatus | null; err: string | null }>({
    data: null,
    err: null,
  });
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const tick = Date.now();
      try {
        const res = await fetch(`${IMPERIAL_API_URL}/api/v1/status`);
        if (cancelled) return;
        if (res.ok) setImperial({ data: await res.json(), err: null });
        else setImperial({ data: null, err: "non-2xx" });
      } catch (e) {
        if (!cancelled) setImperial({ data: null, err: (e as Error).message });
      }
      if (!cancelled) setLastUpdate(tick);
    }
    void poll();
    const id = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];

    if (imperial.data) {
      const d = imperial.data;
      const dbOk = d.db !== "down";
      const idxOk = d.indexer?.status === "ok";
      const botOk = d.orderBot?.status === "ok";
      const color: Color = dbOk && idxOk && botOk ? "ok" : !dbOk && !idxOk && !botOk ? "down" : "warn";
      out.push({
        label: "imperial-rest",
        color,
        detail: `db=${d.db} · indexer=${d.indexer?.status ?? "—"} · orderBot=${d.orderBot?.status ?? "—"}`,
        href: `${IMPERIAL_API_URL}/api/v1/status`,
      });
    } else {
      out.push({ label: "imperial-rest", color: "down", detail: `down: ${imperial.err ?? "unknown"}` });
    }

    out.push({
      label: "imperial-ws",
      color: wsEventsPerSecond === undefined ? "idle" : wsEventsPerSecond > 0 ? "ok" : "warn",
      detail: wsEventsPerSecond === undefined ? "not subscribed on this page" : `${wsEventsPerSecond.toFixed(1)} events/sec`,
    });

    return out;
  }, [imperial, wsEventsPerSecond]);

  return (
    <section className="space-y-2 border border-metric-border bg-surface-1 p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-secondary">Health</h2>
        <span className="font-mono text-[10px] text-text-secondary/60">
          {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "—"}
        </span>
      </header>
      <table className="w-full font-mono text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-metric-border/40 last:border-b-0">
              <td className="w-3 py-1.5">
                <Dot color={r.color} />
              </td>
              <td className="w-32 py-1.5 text-text-primary">{r.label}</td>
              <td className="py-1.5 text-text-secondary">
                {r.href ? (
                  <a href={r.href} target="_blank" rel="noreferrer" className="hover:text-metric-primary">
                    {r.detail}
                  </a>
                ) : (
                  r.detail
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Dot({ color }: { color: Color }) {
  const cls =
    color === "ok"
      ? "bg-metric-buy"
      : color === "warn"
      ? "bg-yellow-400"
      : color === "down"
      ? "bg-metric-sell"
      : "bg-text-secondary/40";
  return <span className={`inline-block h-2 w-2 ${cls}`} aria-hidden />;
}
