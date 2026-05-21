import { create } from "zustand";

export interface DepthLevel {
  price: number;
  size: number;
}

export interface DepthSnapshot {
  symbol: string;
  mid: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

interface OrderbookStore {
  snapshot: DepthSnapshot | null;
  setSnapshot: (snapshot: DepthSnapshot | null) => void;
}

export const useOrderbookStore = create<OrderbookStore>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));
