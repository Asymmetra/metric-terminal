import { create } from "zustand";

/** Live per-symbol funding (per-hour percent), best available venue. */
export interface FundingInfo {
  longPerHourPct: number | null;
  shortPerHourPct: number | null;
  venue: string;
}

interface StatsStore {
  /** symbol → latest mark price (last-writer-wins across venues). */
  marks: Record<string, number>;
  /** symbol → latest funding. */
  funding: Record<string, FundingInfo>;
  setMark: (symbol: string, price: number) => void;
  setFunding: (symbol: string, info: FundingInfo) => void;
}

export const useStatsStore = create<StatsStore>((set) => ({
  marks: {},
  funding: {},
  setMark: (symbol, price) =>
    set((s) => (s.marks[symbol] === price ? s : { marks: { ...s.marks, [symbol]: price } })),
  setFunding: (symbol, info) =>
    set((s) => ({ funding: { ...s.funding, [symbol]: info } })),
}));
