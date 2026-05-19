"use client";

/**
 * Imperial JWT storage.
 *
 * Stored in localStorage keyed by wallet pubkey so multiple connected
 * wallets in the same browser don't stomp each other. Auto-cleared
 * 60 seconds before the server-reported expiry (clock skew buffer).
 */

const KEY_PREFIX = "imperial:jwt:";
const EXPIRY_GUARD_SECS = 60;

interface StoredJwt {
  jwt: string;
  expiresAt: number; // unix seconds
}

export function loadJwt(wallet: string): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY_PREFIX + wallet);
  if (!raw) return null;
  try {
    const parsed: StoredJwt = JSON.parse(raw);
    const nowSecs = Math.floor(Date.now() / 1000);
    if (parsed.expiresAt - EXPIRY_GUARD_SECS <= nowSecs) {
      window.localStorage.removeItem(KEY_PREFIX + wallet);
      return null;
    }
    return parsed.jwt;
  } catch {
    return null;
  }
}

export function saveJwt(wallet: string, jwt: string, expiresAt: number): void {
  if (typeof window === "undefined") return;
  const body: StoredJwt = { jwt, expiresAt };
  window.localStorage.setItem(KEY_PREFIX + wallet, JSON.stringify(body));
}

export function clearJwt(wallet: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY_PREFIX + wallet);
}
