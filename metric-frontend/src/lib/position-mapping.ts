/**
 * Pure mappers from an Imperial position's stringly-typed fields to the terminal's
 * own types. Extracted from Positions.tsx so the close-path venue resolution — the
 * single most consequential string heuristic in the app — is unit-testable.
 */

import type { VenueTag } from "@/lib/imperial/types";

/**
 * Resolve which venue (and therefore which `underwriter` code) a position closes on,
 * from the `underwriter`/`source` strings Imperial stamps on `/positions` rows.
 *
 * Imperial stamps `underwriter` as the exact lowercase venue tag (observed: "gmtrade",
 * "phoenix"; so Flash v1 → "flash_trade", Flash v2 → "flash_v2"). Flash v1 and v2 share
 * the "flash" substring, so the v2 marker MUST be checked before falling back to v1 —
 * a flash_v2 position closed on Flash v1's underwriter (code 1) would be rejected.
 * `source` is folded in defensively in case a future build stamps the v2 marker there.
 */
export function venueOf(p: { underwriter: string; source: string }): VenueTag {
  const u = `${p.underwriter} ${p.source}`.toLowerCase();
  if (u.includes("jupiter")) return "jupiter";
  if (u.includes("flash")) return u.includes("v2") ? "flash_v2" : "flash_trade";
  if (u.includes("gm")) return "gmtrade";
  return "phoenix";
}

/** Normalize Imperial's side string to the terminal's long/short. */
export function sideOf(side: string): "long" | "short" {
  return side.toLowerCase().includes("short") ? "short" : "long";
}
