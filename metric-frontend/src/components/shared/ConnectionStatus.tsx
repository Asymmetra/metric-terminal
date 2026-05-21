"use client";

import { useMarketStore } from "@/stores/marketStore";

/**
 * Thin banner shown only while the Imperial market WS is not delivering
 * data. Driven by the heartbeat in lib/market-data.ts.
 */
export function ConnectionStatus() {
  const connected = useMarketStore((s) => s.connected);
  if (connected) return null;

  return (
    <div className="flex items-center justify-center gap-2 border-b border-metric-sell/20 bg-metric-sell/10 px-3 py-1">
      <div
        className="h-1.5 w-1.5 animate-pulse bg-metric-sell"
        style={{ borderRadius: "50%" }}
      />
      <span className="font-mono text-[10px] text-metric-sell">
        Connecting to Imperial market feed…
      </span>
    </div>
  );
}
