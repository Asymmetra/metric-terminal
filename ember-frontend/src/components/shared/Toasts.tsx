"use client";

import { useToastStore, Toast } from "@/stores/toastStore";
import clsx from "clsx";

function ToastIcon({ type }: { type: Toast["type"] }) {
  if (type === "success") {
    return (
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 8.5l3.5 3.5L13 4" />
      </svg>
    );
  }
  if (type === "error") {
    return (
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
      </svg>
    );
  }
  if (type === "loading") {
    return (
      <svg className="h-3.5 w-3.5 shrink-0 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
        <path d="M8 2a6 6 0 014.9 9.4" />
      </svg>
    );
  }
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4M8 5v.5" />
    </svg>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <div
      className={clsx(
        "flex items-start gap-2.5 border-l-2 border px-3 py-2.5 font-mono text-[11px] toast-slide-in",
        "shadow-[0_4px_24px_rgba(0,0,0,0.4)]",
        toast.type === "success" && "border-ember-green/20 border-l-ember-green bg-ember-green/[0.08] text-ember-green",
        toast.type === "error" && "border-ember-red/20 border-l-ember-red bg-ember-red/[0.08] text-ember-red",
        toast.type === "info" && "border-ember-border border-l-ember-orange bg-surface-l2 text-text-secondary",
        toast.type === "loading" && "border-ember-border border-l-ember-orange bg-surface-l2 text-ember-orange"
      )}
    >
      <ToastIcon type={toast.type} />
      <span className="flex-1 leading-relaxed">{toast.message}</span>
      <button
        onClick={() => removeToast(toast.id)}
        className="shrink-0 text-current/60 transition-colors hover:text-current"
      >
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-3 right-3 z-[200] flex flex-col gap-1.5 w-[340px]">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
