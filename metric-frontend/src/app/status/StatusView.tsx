"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HealthPanel } from "@/components/health/HealthPanel";
import { IMPERIAL_WS_URL } from "@/lib/imperial";

/**
 * Standalone health/status view. Same HealthPanel as /terminal, scaled up,
 * with quick-jump links to the trading surfaces. Live WS-events/sec gauge
 * opens a WS directly to Imperial /ws/market — no dependency on a deployed
 * metric-backend, so the dashboard works standalone on Vercel.
 */
export default function StatusView() {
  const [wsRate, setWsRate] = useState(0);
  const [wsState, setWsState] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    const ws = new WebSocket(`${IMPERIAL_WS_URL}/ws/market`);
    let recent: number[] = [];
    let alive = true;
    ws.onopen = () => {
      setWsState("open");
      ws.send(JSON.stringify({ type: "subscribe_mark_prices" }));
      ws.send(JSON.stringify({ type: "subscribe_funding_rates" }));
      ws.send(JSON.stringify({ type: "subscribe_phoenix_depth", symbols: ["SOL"] }));
    };
    ws.onmessage = () => {
      const now = Date.now();
      recent.push(now);
      recent = recent.filter((t) => now - t < 10_000);
    };
    ws.onclose = () => setWsState("closed");
    const id = setInterval(() => {
      if (!alive) return;
      const now = Date.now();
      const last10 = recent.filter((t) => now - t < 10_000);
      setWsRate(last10.length / 10);
    }, 1_000);
    return () => {
      alive = false;
      clearInterval(id);
      ws.close();
    };
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6 text-text-primary">
      <header className="flex items-baseline justify-between">
        <div>
          <div className="font-mono text-[10px] tracking-[0.35em] text-text-secondary uppercase">
            Metric Terminal
          </div>
          <h1 className="font-mono text-2xl text-metric-primary">Status</h1>
        </div>
        <nav className="flex gap-3 font-mono text-[10px] uppercase tracking-wider">
          <Link href="/terminal" className="text-text-secondary/70 hover:text-text-primary">
            Terminal
          </Link>
          <Link href="/debug" className="text-text-secondary/70 hover:text-text-primary">
            Debug
          </Link>
        </nav>
      </header>

      <p className="font-mono text-xs text-text-secondary">
        Live health of every upstream/downstream feed the trading stack
        depends on. Refreshes every 5 seconds.
      </p>

      <HealthPanel wsEventsPerSecond={wsRate} />

      <section className="space-y-2 border border-metric-border bg-surface-1 p-4">
        <h2 className="font-mono text-[10px] tracking-[0.2em] text-text-secondary uppercase">
          imperial /ws/market ({wsState})
        </h2>
        <p className="font-mono text-xs text-text-secondary">
          Subscribed channels: <span className="text-text-primary">mark_prices · funding_rates · phoenix_depth (SOL)</span>
        </p>
        <p className="font-mono text-xs text-text-secondary">
          Rolling 10s rate: <span className="text-metric-primary">{wsRate.toFixed(2)} events/sec</span>
        </p>
        <p className="font-mono text-[10px] text-text-secondary/60">
          Healthy when mark_prices ticks at ~1–5 Hz on Phoenix-listed
          symbols. A flat rate of 0 means Imperial&apos;s /ws/market is
          disconnected or you&apos;re subscribed to an inactive symbol.
        </p>
      </section>

      <section className="space-y-2 border border-metric-border bg-surface-1 p-4">
        <h2 className="font-mono text-[10px] tracking-[0.2em] text-text-secondary uppercase">
          What a green stack looks like
        </h2>
        <ul className="space-y-1 font-mono text-[11px] text-text-secondary">
          <li>
            <span className="text-metric-buy">●</span> imperial-rest — db ok,
            indexer ok, orderBot ok
          </li>
          <li>
            <span className="text-metric-buy">●</span> imperial-ws — events
            ticking &gt; 0/sec on this page
          </li>
        </ul>
      </section>
    </div>
  );
}
