"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL } from "@/lib/constants";
import { IMPERIAL_API_URL } from "@/lib/imperial/config";

/**
 * Live health checkpoint for the Metric ↔ Imperial pipeline.
 *
 * Polls four sources and renders a compact green/amber/red row per source:
 *
 *   metric-rest    GET {API_BASE_URL}/health
 *   metric-relay   GET {API_BASE_URL}/health/relay   (per-channel last-seen)
 *   imperial-rest  GET {IMPERIAL_API_URL}/api/v1/status
 *   imperial-ws    counts live messages received by useWsHealth() — wired
 *                  separately on /terminal via the props passthrough below.
 */

type Color = "ok" | "warn" | "down" | "idle";

type Row = {
  label: string;
  color: Color;
  detail: string;
  href?: string;
};

interface ImperialStatus {
  db: string;
  indexer?: { status: string } | null;
  orderBot?: { status: string } | null;
}

interface RelayChannel {
  channel: string;
  age_secs: number | null;
}

interface RelayStatus {
  status: string;
  channels: RelayChannel[];
}

export function HealthPanel({
  wsEventsPerSecond,
}: {
  /** Live message count from the consuming page's WS connection. */
  wsEventsPerSecond?: number;
}) {
  const [imperial, setImperial] = useState<{ data: ImperialStatus | null; err: string | null }>(
    { data: null, err: null }
  );
  const [metricHealth, setMetricHealth] = useState<{ ok: boolean; err: string | null }>(
    { ok: false, err: null }
  );
  const [relay, setRelay] = useState<{ data: RelayStatus | null; err: string | null }>(
    { data: null, err: null }
  );
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Poll every 5s.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const tick = Date.now();
      const [metricRes, relayRes, imperialRes] = await Promise.allSettled([
        fetch(`${API_BASE_URL}/health`),
        fetch(`${API_BASE_URL}/health/relay`),
        fetch(`${IMPERIAL_API_URL}/api/v1/status`),
      ]);
      if (cancelled) return;

      if (metricRes.status === "fulfilled" && metricRes.value.ok) {
        setMetricHealth({ ok: true, err: null });
      } else {
        setMetricHealth({
          ok: false,
          err: metricRes.status === "rejected" ? metricRes.reason?.message : "non-2xx",
        });
      }

      if (relayRes.status === "fulfilled" && relayRes.value.ok) {
        try {
          setRelay({ data: await relayRes.value.json(), err: null });
        } catch (e) {
          setRelay({ data: null, err: (e as Error).message });
        }
      } else {
        setRelay({
          data: null,
          err: relayRes.status === "rejected" ? relayRes.reason?.message : "non-2xx",
        });
      }

      if (imperialRes.status === "fulfilled" && imperialRes.value.ok) {
        try {
          setImperial({ data: await imperialRes.value.json(), err: null });
        } catch (e) {
          setImperial({ data: null, err: (e as Error).message });
        }
      } else {
        setImperial({
          data: null,
          err: imperialRes.status === "rejected"
            ? imperialRes.reason?.message ?? "fetch failed"
            : "non-2xx",
        });
      }

      setLastUpdate(tick);
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

    // metric-rest
    out.push({
      label: "metric-rest",
      color: metricHealth.ok ? "ok" : metricHealth.err ? "down" : "idle",
      detail: metricHealth.ok
        ? `${API_BASE_URL}/health → 200`
        : `down: ${metricHealth.err ?? "unknown"}`,
      href: `${API_BASE_URL}/health`,
    });

    // metric-relay
    if (relay.data) {
      const chans = relay.data.channels;
      const total = chans.length;
      const stale = chans.filter((c) => (c.age_secs ?? 0) > 120).length;
      const youngest =
        chans.length > 0
          ? Math.min(...chans.map((c) => c.age_secs ?? Number.MAX_SAFE_INTEGER))
          : null;
      const color: Color =
        total === 0 ? "idle" : stale === total ? "down" : stale > 0 ? "warn" : "ok";
      out.push({
        label: "metric-relay",
        color,
        detail: `${total} channels · ${stale} stale · youngest ${youngest ?? "—"}s`,
        href: `${API_BASE_URL}/health/relay`,
      });
    } else {
      out.push({
        label: "metric-relay",
        color: "down",
        detail: `down: ${relay.err ?? "unknown"}`,
      });
    }

    // imperial-rest
    if (imperial.data) {
      const d = imperial.data;
      const dbOk = d.db !== "down";
      const idxOk = d.indexer?.status === "ok";
      const botOk = d.orderBot?.status === "ok";
      const color: Color =
        dbOk && idxOk && botOk
          ? "ok"
          : !dbOk && !idxOk && !botOk
          ? "down"
          : "warn";
      out.push({
        label: "imperial-rest",
        color,
        detail: `db=${d.db} · indexer=${d.indexer?.status ?? "—"} · orderBot=${
          d.orderBot?.status ?? "—"
        }`,
        href: `${IMPERIAL_API_URL}/api/v1/status`,
      });
    } else {
      out.push({
        label: "imperial-rest",
        color: "down",
        detail: `down: ${imperial.err ?? "unknown"}`,
      });
    }

    // imperial-ws (consumed via prop)
    out.push({
      label: "imperial-ws",
      color:
        wsEventsPerSecond === undefined
          ? "idle"
          : wsEventsPerSecond > 0
          ? "ok"
          : "warn",
      detail:
        wsEventsPerSecond === undefined
          ? "not subscribed on this page"
          : `${wsEventsPerSecond.toFixed(1)} events/sec`,
    });

    return out;
  }, [metricHealth, relay, imperial, wsEventsPerSecond]);

  return (
    <section className="space-y-2 border border-metric-border bg-surface-1 p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="font-mono text-[10px] tracking-[0.2em] text-text-secondary uppercase">
          Health
        </h2>
        <span className="font-mono text-[10px] text-text-secondary/60">
          {lastUpdate ? `${new Date(lastUpdate).toLocaleTimeString()}` : "—"}
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
                  <a
                    href={r.href}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-metric-primary"
                  >
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
