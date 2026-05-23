"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import clsx from "clsx";
import { useMarketStore } from "@/stores/marketStore";

/**
 * Custom wallet button + dropdown, replacing wallet-adapter's `WalletMultiButton`
 * so the menu is on-brand (matches the health-status hover) and can host the
 * isolated-margin profile selector — consolidating it out of the order panel.
 *
 * Connect/change-wallet open the (already brand-styled) wallet-adapter modal;
 * disconnect + copy use the wallet-adapter hooks directly.
 */

const short = (pk: string) => `${pk.slice(0, 4)}..${pk.slice(-4)}`;

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="block w-full rounded-sm px-2 py-1.5 text-left font-mono text-[12px] text-text-primary transition-colors hover:bg-surface-2"
    >
      {children}
    </button>
  );
}

export function WalletMenu() {
  const { publicKey, disconnect, connecting, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const profileIndex = useMarketStore((s) => s.profileIndex);
  const setProfileIndex = useMarketStore((s) => s.setProfileIndex);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const pk = publicKey?.toBase58() ?? null;

  const chipCls =
    "flex items-center gap-2 rounded-md bg-metric-primary px-3 py-1.5 font-mono text-[12px] font-semibold text-metric-bg transition-opacity hover:opacity-90";

  if (!pk) {
    return (
      <button onClick={() => setVisible(true)} className={clsx(chipCls, "uppercase tracking-wider")}>
        {connecting ? "Connecting…" : "Select Wallet"}
      </button>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pk);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className={chipCls}>
        {wallet?.adapter.icon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wallet.adapter.icon} alt="" className="h-3.5 w-3.5 rounded-sm" />
        )}
        {short(pk)}
        <svg className="h-3 w-3 opacity-70" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2.5 4.5L6 8l3.5-3.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-56 border border-metric-border bg-surface-1 p-2 shadow-xl">
          <MenuItem onClick={copy}>{copied ? "Copied ✓" : "Copy address"}</MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              setVisible(true);
            }}
          >
            Change wallet
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              void disconnect();
            }}
          >
            Disconnect
          </MenuItem>

          <div className="mt-2 border-t border-metric-border/50 pt-2">
            <div className="mb-1 px-1 font-mono text-[9px] uppercase tracking-[0.2em] text-text-secondary/60">
              Profile · isolated
            </div>
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <button
                  key={i}
                  onClick={() => setProfileIndex(i)}
                  className={clsx(
                    "flex-1 border py-1 font-mono text-[11px] transition-colors",
                    profileIndex === i
                      ? "border-metric-primary/60 bg-surface-2 text-metric-primary"
                      : "border-metric-border text-text-secondary/70 hover:text-text-secondary"
                  )}
                >
                  {i}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
