"use client";

import dynamic from "next/dynamic";

const StatusView = dynamic(() => import("./StatusView"), {
  ssr: false,
  loading: () => (
    <div className="font-mono text-text-secondary text-xs p-8">
      loading…
    </div>
  ),
});

export default function StatusPage() {
  return (
    <main className="min-h-screen bg-metric-bg p-8">
      <StatusView />
    </main>
  );
}
