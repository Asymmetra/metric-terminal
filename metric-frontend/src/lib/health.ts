"use client";

import { create } from "zustand";

/**
 * Lean health store for the endpoints the terminal actually consumes.
 *
 *   phoenix-ws    wss://perp-api.phoenix.trade/ws  — price + order book
 *   imperial-ws   wss://api.imperial.space/ws/market — marks / funding
 *   phoenix-rest  https://perp-api.phoenix.trade/candles — candle backfill
 *   imperial-rest {IMPERIAL_API_URL}/api/v1/status — symbol list / status
 *
 * WS sources report a `lastMessageAt` heartbeat (fed by the feed code); REST
 * sources report a timed-fetch `latencyMs` + ok flag (fed by the indicator's
 * poller). Status is derived from recency (WS) or latency/ok (REST).
 */

export type HealthColor = "ok" | "warn" | "down" | "idle";

export interface WsLiveness {
  lastMessageAt: number | null;
}
export interface RestLiveness {
  ok: boolean | null;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: number | null;
}

export type WsId = "phoenix-ws" | "imperial-ws";
export type RestId = "phoenix-rest" | "imperial-rest";

interface HealthStore {
  ws: Record<WsId, WsLiveness>;
  rest: Record<RestId, RestLiveness>;
  noteWs: (id: WsId) => void;
  noteRest: (id: RestId, r: RestLiveness) => void;
}

const emptyWs = (): WsLiveness => ({ lastMessageAt: null });
const emptyRest = (): RestLiveness => ({ ok: null, latencyMs: null, detail: null, checkedAt: null });

export const useHealthStore = create<HealthStore>((set) => ({
  ws: { "phoenix-ws": emptyWs(), "imperial-ws": emptyWs() },
  rest: { "phoenix-rest": emptyRest(), "imperial-rest": emptyRest() },
  noteWs: (id) =>
    set((s) => ({ ws: { ...s.ws, [id]: { lastMessageAt: Date.now() } } })),
  noteRest: (id, r) => set((s) => ({ rest: { ...s.rest, [id]: r } })),
}));

/** Imperative bump for non-React feed code. */
export function noteWsHealth(id: WsId) {
  useHealthStore.getState().noteWs(id);
}

// ───────────────────────────── status derivation

const WS_OK_MS = 5_000; // fresh within 5s
const WS_WARN_MS = 20_000; // stale-but-alive up to 20s

export function wsColor(live: WsLiveness, now = Date.now()): HealthColor {
  if (live.lastMessageAt == null) return "idle";
  const age = now - live.lastMessageAt;
  if (age < WS_OK_MS) return "ok";
  if (age < WS_WARN_MS) return "warn";
  return "down";
}

const REST_OK_MS = 600; // snappy
const REST_WARN_MS = 1_500; // sluggish but up

export function restColor(live: RestLiveness): HealthColor {
  if (live.ok == null) return "idle";
  if (!live.ok) return "down";
  if (live.latencyMs == null) return "ok";
  if (live.latencyMs < REST_OK_MS) return "ok";
  if (live.latencyMs < REST_WARN_MS) return "warn";
  return "warn"; // it answered, just slow — never "down" on latency alone
}

/** Roll a set of colors into one overall color (worst-wins, ignoring idle). */
export function overallColor(colors: HealthColor[]): HealthColor {
  const live = colors.filter((c) => c !== "idle");
  if (live.length === 0) return "idle";
  if (live.some((c) => c === "down")) {
    return live.every((c) => c === "down") ? "down" : "warn";
  }
  if (live.some((c) => c === "warn")) return "warn";
  return "ok";
}

/** "<1s ago" / "Ns ago" / "Nm ago" from a ms timestamp. */
export function freshness(lastMs: number | null, now = Date.now()): string {
  if (lastMs == null) return "—";
  const sec = Math.max(0, (now - lastMs) / 1000);
  if (sec < 1) return "<1s ago";
  if (sec < 60) return `${Math.round(sec)}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}
