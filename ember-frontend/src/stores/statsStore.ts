import { create } from "zustand";
import { MarketStats } from "@/types/market";

interface StatsStore {
  stats: MarketStats | null;
  markPrices: Record<string, number>;
  setStats: (stats: MarketStats | null) => void;
  setMarkPrice: (symbol: string, price: number) => void;
}

export const useStatsStore = create<StatsStore>((set) => ({
  stats: null,
  markPrices: {},
  setStats: (stats) => set({ stats }),
  setMarkPrice: (symbol, price) =>
    set((s) => ({ markPrices: { ...s.markPrices, [symbol]: price } })),
}));
