"use client";

import { useEffect, useState } from "react";
import { imperial } from "@/lib/imperial";
import { loadJwt } from "@/lib/imperial/jwt";
import { useTraderStore } from "@/stores/traderStore";

/**
 * Compact, unobtrusive Imperial season-points chip ("◆ 1,234 pts").
 *
 * `getPoints` REQUIRES a JWT (401 without one). To stay unobtrusive we NEVER
 * force the connect signature just to show points — we only fetch when a JWT is
 * already available (in the trader store or cached in localStorage from a prior
 * auth). Renders nothing on no-wallet / no-JWT / no-live-season / any failure.
 *
 * Refreshes on wallet change, when the JWT lands, and on the shared trader
 * refresh tick (bumped after every trade) so points move after activity.
 */
export function PointsChip({ wallet }: { wallet: string | null }) {
  const jwt = useTraderStore((s) => s.jwt);
  const lastRefresh = useTraderStore((s) => s.lastRefresh);
  const [points, setPoints] = useState<number | null>(null);

  useEffect(() => {
    if (!wallet) {
      setPoints(null);
      return;
    }
    const token = jwt ?? loadJwt(wallet);
    if (!token) {
      setPoints(null);
      return;
    }
    let cancelled = false;
    imperial
      .getPoints(wallet, token)
      .then((res) => {
        // No live season ⇒ seasonName null, points 0 — render nothing then.
        if (!cancelled) setPoints(res.seasonName ? res.seasonPoints : null);
      })
      .catch(() => {
        if (!cancelled) setPoints(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, jwt, lastRefresh]);

  if (points == null) return null;

  return (
    <span
      className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11px] text-metric-primary"
      title="Imperial season points"
    >
      <span aria-hidden>◆</span>
      <span className="tabular-nums">{points.toLocaleString("en-US")}</span>
      <span className="text-text-secondary/60">pts</span>
    </span>
  );
}
