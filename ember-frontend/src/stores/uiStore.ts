import { create } from "zustand";

interface UiStore {
  showShortcutOverlay: boolean;
  focusSide: "buy" | "sell" | null;
  setShowShortcutOverlay: (show: boolean) => void;
  toggleShortcutOverlay: () => void;
  setFocusSide: (side: "buy" | "sell" | null) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  showShortcutOverlay: false,
  focusSide: null,
  setShowShortcutOverlay: (show) => set({ showShortcutOverlay: show }),
  toggleShortcutOverlay: () => set((s) => ({ showShortcutOverlay: !s.showShortcutOverlay })),
  setFocusSide: (side) => set({ focusSide: side }),
}));
