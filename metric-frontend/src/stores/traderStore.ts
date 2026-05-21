import { create } from "zustand";
import type { PositionLifecycle, ProfileBalance } from "@/lib/imperial/types";

interface TraderStore {
  positions: PositionLifecycle[];
  balances: ProfileBalance[];
  jwt: string | null;
  /** Bumped whenever positions/balances refetch — chart markers etc. key off it. */
  lastRefresh: number;
  setPositions: (positions: PositionLifecycle[]) => void;
  setBalances: (balances: ProfileBalance[]) => void;
  setJwt: (jwt: string | null) => void;
  bumpRefresh: () => void;
}

export const useTraderStore = create<TraderStore>((set) => ({
  positions: [],
  balances: [],
  jwt: null,
  lastRefresh: 0,
  setPositions: (positions) => set({ positions, lastRefresh: Date.now() }),
  setBalances: (balances) => set({ balances }),
  setJwt: (jwt) => set({ jwt }),
  bumpRefresh: () => set({ lastRefresh: Date.now() }),
}));
