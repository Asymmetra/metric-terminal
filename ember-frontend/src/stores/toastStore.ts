import { create } from "zustand";

export interface Toast {
  id: string;
  type: "success" | "error" | "info" | "loading";
  title: string;
  detail?: string;
  txid?: string;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (type: Toast["type"], title: string, detail?: string) => string;
  updateToast: (id: string, updates: Partial<Pick<Toast, "type" | "title" | "detail" | "txid">>) => void;
  removeToast: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (type, title, detail) => {
    const id = `toast-${nextId++}`;
    set((s) => ({ toasts: [...s.toasts, { id, type, title, detail }] }));
    // Auto-dismiss non-loading toasts after 5s
    if (type !== "loading") {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 5000);
    }
    return id;
  },
  updateToast: (id, updates) =>
    set((s) => ({
      toasts: s.toasts.map((t) => {
        if (t.id !== id) return t;
        const updated = { ...t, ...updates };
        // Start auto-dismiss when transitioning away from loading
        if (t.type === "loading" && updates.type && updates.type !== "loading") {
          setTimeout(() => {
            set((s2) => ({ toasts: s2.toasts.filter((t2) => t2.id !== id) }));
          }, 5000);
        }
        return updated;
      }),
    })),
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
