import { create } from "zustand";
import { Trade } from "@/types/market";

interface TradeStore {
  trades: Trade[];
  addTrades: (newTrades: Trade[]) => void;
  setTrades: (trades: Trade[]) => void;
}

export const useTradeStore = create<TradeStore>((set) => ({
  trades: [],
  addTrades: (newTrades) =>
    set((state) => ({
      trades: [...newTrades, ...state.trades].slice(0, 100),
    })),
  setTrades: (trades) => set({ trades }),
}));
