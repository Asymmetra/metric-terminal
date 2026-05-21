"use client";

import { useEffect } from "react";
import { imperial } from "@/lib/imperial";
import { ImperialWalletWs } from "@/lib/imperial/ws";
import { useTraderStore } from "@/stores/traderStore";

/**
 * Keep the trader store's positions live for `wallet`:
 *  - REST `getPositions` on mount + every 8s,
 *  - immediate refetch on each Imperial `/ws` positions/orders invalidation.
 * Passing null (disconnected) clears positions.
 */
export function useTraderSync(wallet: string | null) {
  const setPositions = useTraderStore((s) => s.setPositions);

  useEffect(() => {
    if (!wallet) {
      setPositions([]);
      return;
    }
    let cancelled = false;

    const refetch = async () => {
      try {
        const res = await imperial.getPositions(wallet);
        if (!cancelled) setPositions(res.dataList ?? []);
      } catch {
        // transient — next tick retries
      }
    };

    void refetch();
    const poll = setInterval(refetch, 8_000);

    const ws = new ImperialWalletWs(wallet);
    ws.on((raw) => {
      const t = (raw as { type?: string })?.type;
      if (t === "positions_updated" || t === "orders_updated") void refetch();
    });
    ws.connect();

    return () => {
      cancelled = true;
      clearInterval(poll);
      ws.disconnect();
    };
  }, [wallet, setPositions]);
}
