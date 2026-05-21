"use client";

import { useEffect, useState } from "react";

/**
 * Pyth Hermes price stream — optional high-fidelity oracle source for the line
 * chart. Hermes pushes parsed price updates over SSE (EventSource):
 *   GET https://hermes.pyth.network/v2/updates/price/stream?ids[]=<feedId>&parsed=true
 * Each event: { parsed: [{ price: { price, expo, publish_time }, ... }] }.
 *
 * Only symbols with a known feed id are supported; everything else falls back
 * to the Phoenix mark (handled by the caller). Requires `hermes.pyth.network`
 * in the CSP connect-src.
 */

export const HERMES_URL = "https://hermes.pyth.network";

/** Canonical Pyth mainnet price-feed ids (USD pairs). */
export const PYTH_FEED_IDS: Record<string, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

export function hasPythFeed(symbol: string): boolean {
  return symbol in PYTH_FEED_IDS;
}

interface HermesPriceEvent {
  parsed?: Array<{ price?: { price: string; expo: number; publish_time: number } }>;
}

/**
 * Subscribe to a symbol's Pyth price via Hermes SSE while `enabled`.
 * Returns the latest price (USD) or undefined. Closes + clears on
 * disable/unmount/symbol-change; tolerant of stream errors (the line just
 * stops updating from Pyth and the caller can fall back).
 */
export function usePythPrice(symbol: string, enabled: boolean): number | undefined {
  const [price, setPrice] = useState<number | undefined>(undefined);

  useEffect(() => {
    const feedId = PYTH_FEED_IDS[symbol];
    if (!enabled || !feedId || typeof window === "undefined") {
      setPrice(undefined);
      return;
    }
    const url = `${HERMES_URL}/v2/updates/price/stream?ids[]=${feedId}&parsed=true`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as HermesPriceEvent;
        const p = data.parsed?.[0]?.price;
        if (p) setPrice(Number(p.price) * 10 ** p.expo);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      // Hermes hiccup — close; caller falls back to Phoenix until remount.
      es.close();
    };
    return () => es.close();
  }, [symbol, enabled]);

  return price;
}
