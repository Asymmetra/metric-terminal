/**
 * Pure logic for Degen Mode — the 400×/60s one-tap perp game. No React, no network,
 * so the stake/size/timer math and position classification are unit-testable in isolation.
 * Network orchestration (deposit → open → close → claim) lives in DegenGame.tsx, built
 * on the existing trade-flow primitives.
 */

import type { OrderResponse, PositionLifecycle } from "@/lib/imperial/types";
import { isRetryableOrderError, isTransientResolveError, placeOrderWithRetry } from "@/lib/trade-flow";

/** Direction of the bet — chosen at idle, then locked for the whole game. */
export type GameSide = "long" | "short";

/** Fixed game parameters. */
export const GAME_LEVERAGE = 400; // preset leverage for every open + double-down increment
export const GAME_PROFILE = 5; // dedicated isolated profile so the game never touches /terminal positions
export const GAME_SYMBOL = "SOL";
export const GAME_VENUE = "flash_v2" as const;
export const MIN_STAKE_USD = 10; // Imperial's enforced order-bot minimum collateral
export const WINDOW_MS = 60_000; // each open / double-down buys one 60s window

/** Position size (USD notional) for a given stake at the fixed game leverage. */
export function sizeForStake(stakeUsd: number): number {
  return +(stakeUsd * GAME_LEVERAGE).toFixed(2);
}

/** Human error if the stake can't be submitted, else null. */
export function validateStake(stakeUsd: number): string | null {
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) return "Enter a stake.";
  if (stakeUsd < MIN_STAKE_USD) return `Minimum stake is $${MIN_STAKE_USD}.`;
  return null;
}

/** Deadline when a position first fills: now + one window. */
export function initialDeadline(filledAtMs: number): number {
  return filledAtMs + WINDOW_MS;
}

/**
 * Deadline after a double-down. Extends the END of the current window by 60s — NOT
 * "now + 60s". So doubling down 30s into a 60s window pushes the deadline to 120s, not 90s.
 */
export function extendDeadline(deadlineMs: number): number {
  return deadlineMs + WINDOW_MS;
}

/** Milliseconds left until the deadline (never negative). */
export function remainingMs(deadlineMs: number, nowMs: number): number {
  return Math.max(0, deadlineMs - nowMs);
}

/** m:ss countdown from a remaining-ms value. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Is this position row the game's open SOL/flash_v2 position in the game profile? */
function isGameRow(p: PositionLifecycle): boolean {
  const tag = `${p.underwriter} ${p.source}`.toLowerCase();
  const inProfile = p.profileIndex == null || p.profileIndex === GAME_PROFILE;
  const isFlashV2 = tag.includes("flash") && tag.includes("v2");
  const isOpen = p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0;
  return p.asset === GAME_SYMBOL && inProfile && isFlashV2 && isOpen;
}

/** The game's currently-open position, if any. */
export function findGamePosition(positions: PositionLifecycle[]): PositionLifecycle | undefined {
  return positions.find(isGameRow);
}

/** Numeric helper for stringified position fields. */
export function num(v: string | null | undefined): number {
  return v == null ? 0 : Number(v) || 0;
}

/** Max close-order placement attempts (1 initial + retries) before giving up. */
export const CLOSE_ORDER_RETRIES = 5;
/** Delay between retryable close attempts. */
export const CLOSE_ORDER_RETRY_MS = 800;

/**
 * Whether a failed close-order response is worth re-placing. Mirrors the OPEN
 * path's retry policy: both a cold-cache market-resolution miss AND a transient
 * placement bounce ("Failed to place order — please try again", common on the
 * 400× Flash V2 path) are retryable. A hard rejection (insufficient margin, no
 * position, max leverage) is NOT — re-placing it just loops forever, which is the
 * exact "Close failed — retrying" symptom we're fixing.
 */
export function isRetryableCloseError(error: string | null | undefined): boolean {
  return isTransientResolveError(error) || isRetryableOrderError(error);
}

/**
 * Place a close (Decrease) order, retrying transient placement/resolve failures
 * up to `retries` total attempts. Returns the final OrderResponse — success on
 * the first fill, or the last failed response after exhausting retries (the
 * caller decides whether to re-arm). A hard (non-retryable) rejection returns
 * immediately without burning the remaining attempts.
 *
 * Thin adapter over the SHARED {@link placeOrderWithRetry} loop in trade-flow, so
 * the open (Increase) path, the terminal close (`closeAndWithdraw`), and the game
 * close all run the exact same retry classification — they can't drift apart. The
 * game close uses one `retryMs` for both transient classes; the resolve/order
 * back-offs are therefore set equal here.
 *
 * Decoupled from React/network specifics: takes the place fn + a sleeper so it's
 * unit-testable and shared by every close path (auto-close, double-down fallthrough).
 */
export async function placeCloseWithRetry(
  place: () => Promise<OrderResponse>,
  opts: {
    retries?: number;
    retryMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, total: number) => void;
  } = {}
): Promise<OrderResponse> {
  const total = Math.max(1, opts.retries ?? CLOSE_ORDER_RETRIES);
  const retryMs = opts.retryMs ?? CLOSE_ORDER_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return placeOrderWithRetry(place, {
    maxAttempts: total,
    resolveRetryMs: retryMs,
    orderRetryMs: retryMs,
    sleep,
    onRetry: opts.onRetry,
  });
}
