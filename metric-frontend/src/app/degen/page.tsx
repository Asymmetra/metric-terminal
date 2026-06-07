"use client";

import dynamic from "next/dynamic";

// Client-only: pulls in the Solana adapter + liveline chart, which must not SSR.
const DegenGame = dynamic(() => import("./DegenGame"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center font-mono text-sm text-text-secondary">
      loading…
    </div>
  ),
});

export default function DegenPage() {
  return (
    <main className="h-screen overflow-hidden bg-metric-bg">
      <DegenGame />
    </main>
  );
}
