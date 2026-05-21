"use client";

import dynamic from "next/dynamic";

// The trading terminal is wallet-aware and chart-heavy — client-only so the
// router doesn't try to SSR the Solana wallet adapter or lightweight-charts.
const Terminal = dynamic(() => import("./Terminal"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center font-mono text-xs text-text-secondary">
      loading terminal…
    </div>
  ),
});

export default function TerminalPage() {
  return (
    <main className="h-screen overflow-hidden bg-metric-bg">
      <Terminal />
    </main>
  );
}
