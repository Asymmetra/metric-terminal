"use client";

import { useState } from "react";
import { useToastStore, Toast } from "@/stores/toastStore";
import clsx from "clsx";

function ToastIcon({ type }: { type: Toast["type"] }) {
  if (type === "loading") {
    return (
      <svg className="h-3.5 w-3.5 shrink-0 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
        <path d="M8 2a6 6 0 014.9 9.4" />
      </svg>
    );
  }
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
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4M8 5v.5" />
    </svg>
  );
}

function CopyButton({ toast }: { toast: Toast }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = toast.detail ? `${toast.title}: ${toast.detail}` : toast.title;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 text-current/60 transition-colors hover:text-current"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 8.5l3.5 3.5L13 4" />
        </svg>
      ) : (
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5" y="5" width="8" height="8" rx="1" />
          <path d="M3 11V3h8" />
        </svg>
      )}
    </button>
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
      <div className="flex-1 min-w-0">
        <span className="font-semibold leading-relaxed">{toast.title}</span>
        {toast.detail && (
          <p className="text-[10px] opacity-80 break-words mt-0.5 leading-relaxed">{toast.detail}</p>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <CopyButton toast={toast} />
        <button
          onClick={() => removeToast(toast.id)}
          className="shrink-0 text-current/60 transition-colors hover:text-current"
        >
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-3 right-3 z-[200] flex flex-col gap-1.5 w-[420px]">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
