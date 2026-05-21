"use client";

import dynamic from "next/dynamic";

// Low-level debug surface: signer state, Imperial JWT auth, raw balances,
// positions JSON, live mark grid, manual deposit. The real trading UI lives
// at /terminal — this page is kept for diagnostics.
const DebugView = dynamic(() => import("./DebugView"), {
  ssr: false,
  loading: () => <div className="font-mono text-xs text-text-secondary">loading…</div>,
});

export default function DebugPage() {
  return (
    <main className="min-h-screen bg-metric-bg p-8">
      <DebugView />
    </main>
  );
}
