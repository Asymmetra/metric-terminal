import { create } from "zustand";

export interface MarketInfo {
  symbol: string;
  /** Venues currently quoting this symbol (e.g. ["phoenix","jupiter"]). */
  venues: string[];
  /** True when Phoenix quotes it — gates the order book + chart candles. */
  phoenix: boolean;
}

interface MarketStore {
  markets: MarketInfo[];
  selectedSymbol: string;
  /** Active isolated-margin profile (0..5). Shared by the wallet menu + order panel. */
  profileIndex: number;
  /** Imperial market WS connection state. */
  connected: boolean;
  setMarkets: (markets: MarketInfo[]) => void;
  setSelectedSymbol: (symbol: string) => void;
  setProfileIndex: (profileIndex: number) => void;
  setConnected: (connected: boolean) => void;
}

export const useMarketStore = create<MarketStore>((set) => ({
  markets: [],
  selectedSymbol: "SOL",
  profileIndex: 0,
  connected: false,
  setMarkets: (markets) => set({ markets }),
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
  setProfileIndex: (profileIndex) => set({ profileIndex }),
  setConnected: (connected) => set({ connected }),
}));
