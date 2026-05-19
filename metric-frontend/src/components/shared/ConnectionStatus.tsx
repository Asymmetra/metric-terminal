"use client";

import { useState, useEffect } from "react";
import { wsClient } from "@/lib/ws";

export function ConnectionStatus() {
  const [status, setStatus] = useState<"connected" | "disconnected" | "reconnecting">("disconnected");

  useEffect(() => {
    return wsClient.onStatus(setStatus);
  }, []);

  if (status === "connected") return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-metric-sell/10 px-3 py-1 border-b border-metric-sell/20">
      <div className="h-1.5 w-1.5 bg-metric-sell animate-pulse" style={{ borderRadius: "50%" }} />
      <span className="font-mono text-[10px] text-metric-sell">
        {status === "reconnecting" ? "Reconnecting..." : "Disconnected"}
      </span>
    </div>
  );
}
