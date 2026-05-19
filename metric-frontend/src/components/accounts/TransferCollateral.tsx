"use client";

import { useState, useEffect, useRef } from "react";
import { useTransactionBuilder } from "@/hooks/useTransactionBuilder";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

interface SubaccountOption {
  index: number;
  label: string;
  collateral: number;
}

interface TransferCollateralProps {
  onClose: () => void;
  subaccounts: SubaccountOption[];
}

export function TransferCollateral({ onClose, subaccounts }: TransferCollateralProps) {
  const [fromIdx, setFromIdx] = useState(subaccounts[0]?.index ?? 0);
  const [toIdx, setToIdx] = useState(subaccounts.length > 1 ? subaccounts[1]?.index ?? 1 : 1);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { transferCollateral, connected } = useTransactionBuilder();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const fromAccount = subaccounts.find((s) => s.index === fromIdx);
  const maxAmount = fromAccount?.collateral || 0;

  const handleSubmit = async () => {
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (fromIdx === toIdx) {
      setError("Source and destination must be different");
      return;
    }
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      await transferCollateral(fromIdx, toIdx, parsed);
      setSuccess(`Transferred ${formatUsd(parsed)} USDC`);
      setAmount("");
    } catch (e: any) {
      setError(e?.message || "Transfer failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="w-[360px] border border-metric-border bg-surface-1 shadow-[0_16px_64px_rgba(0,0,0,0.6)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-metric-border px-4 py-3">
          <span className="font-mono text-xs font-medium uppercase tracking-wider text-text-primary">
            Transfer Collateral
          </span>
          <button
            onClick={onClose}
            className="text-text-secondary/60 transition-colors hover:text-text-primary"
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">
          {/* From */}
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-text-secondary/70 uppercase">
              From
            </label>
            <select
              value={fromIdx}
              onChange={(e) => { setFromIdx(Number(e.target.value)); setError(null); }}
              className="w-full border border-metric-border bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary focus:border-metric-primary/60 focus:outline-none"
            >
              {subaccounts.map((s) => (
                <option key={s.index} value={s.index}>
                  {s.label} — {formatUsd(s.collateral)}
                </option>
              ))}
            </select>
          </div>

          {/* To */}
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-text-secondary/70 uppercase">
              To
            </label>
            <select
              value={toIdx}
              onChange={(e) => { setToIdx(Number(e.target.value)); setError(null); }}
              className="w-full border border-metric-border bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary focus:border-metric-primary/60 focus:outline-none"
            >
              {subaccounts.map((s) => (
                <option key={s.index} value={s.index}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* Amount */}
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-text-secondary/70 uppercase">
              Amount
            </label>
            <div className="relative">
              <input
                type="number"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setError(null); }}
                placeholder="0.00"
                autoFocus
                className="w-full border border-metric-border bg-surface-2 py-2.5 pl-3 pr-20 font-mono text-sm text-text-primary placeholder:text-text-secondary/40 focus:border-metric-primary/60 focus:outline-none transition-colors"
              />
              <button
                onClick={() => setAmount(maxAmount.toFixed(2))}
                className="absolute right-10 top-1/2 -translate-y-1/2 font-mono text-[9px] text-metric-primary hover:text-metric-primary/80"
              >
                MAX
              </button>
              <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-secondary/60">
                USDC
              </span>
            </div>
          </div>

          {error && <div className="font-mono text-[10px] text-metric-sell">{error}</div>}
          {success && <div className="font-mono text-[10px] text-metric-buy">{success}</div>}

          <button
            onClick={handleSubmit}
            disabled={!connected || !amount || loading || fromIdx === toIdx}
            className={clsx(
              "w-full py-2.5 font-mono text-[11px] font-medium uppercase tracking-wider transition-all duration-150",
              !connected || fromIdx === toIdx
                ? "bg-surface-2 text-text-secondary/50 cursor-not-allowed"
                : "bg-metric-primary text-white hover:brightness-110 active:brightness-95",
              loading && "opacity-50 pointer-events-none"
            )}
          >
            {loading ? "Processing..." : !connected ? "Connect Wallet" : "Transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}
