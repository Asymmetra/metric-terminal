import { create } from "zustand";

/** Live per-symbol funding (per-hour percent), best available venue. */
export interface FundingInfo {
  longPerHourPct: number | null;
  shortPerHourPct: number | null;
  venue: string;
}

/**
 * Venue preference for the canonical mark price. Imperial streams a
 * `mark_price_update` per venue for the same symbol (each a few cents
 * apart); without a fixed preference, last-writer-wins makes the price —
 * and any chart fed from it — flip-flop between venues. We anchor to
 * Phoenix (the venue we chart) and fall back down the list.
 */
const VENUE_PRIORITY = ["phoenix", "jupiter", "flash", "flash_trade", "gmtrade"];

function pickMark(byVenue: Record<string, number>): number | undefined {
  for (const v of VENUE_PRIORITY) {
    if (typeof byVenue[v] === "number") return byVenue[v];
  }
  // Fall back to any present venue not in the priority list.
  const any = Object.values(byVenue);
  return any.length ? any[0] : undefined;
}

interface StatsStore {
  /** symbol → canonical mark (venue-priority resolved; stable, no flip-flop). */
  marks: Record<string, number>;
  /** symbol → per-venue latest mark (source of truth for `marks`). */
  marksByVenue: Record<string, Record<string, number>>;
  /** symbol → latest funding. */
  funding: Record<string, FundingInfo>;
  setVenueMark: (symbol: string, venue: string, price: number) => void;
  setFunding: (symbol: string, info: FundingInfo) => void;
}

export const useStatsStore = create<StatsStore>((set) => ({
  marks: {},
  marksByVenue: {},
  funding: {},
  setVenueMark: (symbol, venue, price) =>
    set((s) => {
      const byVenue = { ...(s.marksByVenue[symbol] ?? {}), [venue]: price };
      const resolved = pickMark(byVenue);
      const marks =
        resolved !== undefined && resolved !== s.marks[symbol]
          ? { ...s.marks, [symbol]: resolved }
          : s.marks;
      return { marksByVenue: { ...s.marksByVenue, [symbol]: byVenue }, marks };
    }),
  setFunding: (symbol, info) => set((s) => ({ funding: { ...s.funding, [symbol]: info } })),
}));
