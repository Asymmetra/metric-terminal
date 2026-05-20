"use client";

import dynamic from "next/dynamic";

// Wallet-aware terminal content is client-only; dynamic-import keeps the
// router from trying to SSR the Solana wallet adapter context.
const TerminalView = dynamic(() => import("./TerminalView"), {
  ssr: false,
  loading: () => (
    <div className="font-mono text-text-secondary text-xs">loading…</div>
  ),
});

export default function TerminalPage() {
  return (
    <main className="min-h-screen bg-metric-bg p-8">
      <TerminalView />
    </main>
  );
}
