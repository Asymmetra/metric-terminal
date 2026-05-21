import { create } from "zustand";

export type MobileTab = "book" | "trade" | "positions";

interface UiStore {
  focusSide: "buy" | "sell" | null;
  mobileTab: MobileTab;
  setFocusSide: (side: "buy" | "sell" | null) => void;
  setMobileTab: (tab: MobileTab) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  focusSide: null,
  mobileTab: "trade",
  setFocusSide: (side) => set({ focusSide: side }),
  setMobileTab: (tab) => set({ mobileTab: tab }),
}));
