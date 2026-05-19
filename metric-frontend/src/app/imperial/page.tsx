"use client";

import dynamic from "next/dynamic";

// Wallet-aware demo content is client-only; dynamic-import keeps the
// router from trying to SSR the Solana wallet adapter context.
const ImperialDemo = dynamic(() => import("./ImperialDemo"), {
  ssr: false,
  loading: () => (
    <div className="font-mono text-text-secondary text-xs">loading…</div>
  ),
});

export default function ImperialDemoPage() {
  return (
    <main className="min-h-screen bg-metric-bg p-8">
      <ImperialDemo />
    </main>
  );
}
