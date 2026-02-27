import { create } from "zustand";
import { MarketStats } from "@/types/market";

interface StatsStore {
  stats: MarketStats | null;
  setStats: (stats: MarketStats | null) => void;
}

export const useStatsStore = create<StatsStore>((set) => ({
  stats: null,
  setStats: (stats) => set({ stats }),
}));
