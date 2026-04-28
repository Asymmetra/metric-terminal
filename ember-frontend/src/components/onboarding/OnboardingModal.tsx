"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTraderStore } from "@/stores/traderStore";
import { api } from "@/lib/api";
import clsx from "clsx";

// Invite-gated onboarding dialog. Shown when:
//   connected && noAccount === true && inviteActivated === false
//
// Phoenix is the source of truth for referral codes — we just forward the
// string to /api/onboard/activate-referral and act on the result. The backend
// treats "already activated" as a success so we don't frustrate users who
// activated previously but never deposited.
//
// "View only" disconnects the wallet, returning the user to the existing
// disconnected state which is already read-only. They can connect a
// different (already-onboarded) wallet if they want to trade.

export function OnboardingModal() {
  const { connected, publicKey, disconnect } = useWallet();
  const noAccount = useTraderStore((s) => s.noAccount);
  const inviteActivated = useTraderStore((s) => s.inviteActivated);
  const setInviteActivated = useTraderStore((s) => s.setInviteActivated);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shouldOpen =
    !!connected && !!publicKey && noAccount === true && inviteActivated === false;

  // Reset transient fields whenever the modal closes so reopening is clean.
  useEffect(() => {
    if (!shouldOpen) {
      setCode("");
      setError(null);
      setSubmitting(false);
    }
  }, [shouldOpen]);

  // Intentionally not closable via Escape — we want the user to make an explicit
  // choice (activate or go view-only) rather than dismiss the modal.

  async function handleActivate() {
    if (!publicKey) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Referral code is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.activateReferral(publicKey.toBase58(), trimmed);
      // already_activated === true means the wallet was previously onboarded;
      // still a success from the user's POV, just skip any success animation.
      setInviteActivated(true);
      if (!res.already_activated) {
        // Optionally we could show a "Welcome!" toast here. Toasts live in
        // terminal/Toasts.tsx — leaving this as a silent success for now so
        // the flow feels unobtrusive.
      }
    } catch (e: any) {
      const msg = typeof e?.message === "string" ? e.message : "";
      // Backend prefixes recoverable errors as "invalid_code:..." or
      // "upstream_error:...". Anything else is shown as-is.
      if (msg.startsWith("invalid_code:")) {
        setError("Invalid referral code. Double-check the code and try again.");
      } else if (msg.startsWith("upstream_error:")) {
        setError("Couldn't reach Phoenix. Try again in a moment.");
      } else if (msg) {
        setError(msg);
      } else {
        setError("Activation failed. Please try again.");
      }
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  }

  function handleViewOnly() {
    // Disconnect the wallet and dismiss the modal. The terminal already
    // renders in a read-only state when no wallet is connected.
    disconnect().catch(() => {});
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !submitting) {
      e.preventDefault();
      handleActivate();
    }
  }

  return (
    <AnimatePresence>
      {shouldOpen && (
        <>
          <motion.div
            key="onboard-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm"
          />
          <motion.div
            key="onboard-panel"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[101] flex items-center justify-center p-4"
          >
            <div className="w-full max-w-[420px] border border-ember-border bg-surface-l1 shadow-[0_16px_64px_rgba(0,0,0,0.6)]">
              <div className="border-b border-ember-border/60 px-5 py-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ember-orange">
                  Welcome to Ember
                </span>
              </div>

              <div className="flex flex-col gap-4 px-5 py-5">
                <p className="font-mono text-[11px] leading-relaxed text-text-secondary">
                  Ember is in invite-only beta. Enter a referral code to activate
                  your account and unlock trading.
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/60">
                    Referral code
                  </span>
                  <input
                    type="text"
                    autoFocus
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.toUpperCase());
                      if (error) setError(null);
                    }}
                    onKeyDown={handleKey}
                    disabled={submitting}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="EMBER-XXXX"
                    className={clsx(
                      "w-full border bg-ember-black px-3 py-2 font-mono text-[13px] tracking-wider text-text-primary outline-none transition-colors",
                      error
                        ? "border-ember-red/70 focus:border-ember-red"
                        : "border-ember-border focus:border-ember-orange/70"
                    )}
                  />
                  {error && (
                    <span className="font-mono text-[10px] text-ember-red">
                      {error}
                    </span>
                  )}
                </label>

                <div className="flex flex-col gap-2 pt-1">
                  <button
                    onClick={handleActivate}
                    disabled={submitting || code.trim().length === 0}
                    className={clsx(
                      "flex items-center justify-center gap-2 border px-4 py-2 font-mono text-[11px] uppercase tracking-wider transition-colors",
                      submitting || code.trim().length === 0
                        ? "cursor-not-allowed border-ember-border bg-surface-l2 text-text-secondary/40"
                        : "border-ember-orange bg-ember-orange/15 text-ember-orange hover:bg-ember-orange/25"
                    )}
                  >
                    {submitting ? "Activating…" : "Activate & continue"}
                  </button>
                  <button
                    onClick={handleViewOnly}
                    disabled={submitting}
                    className="flex items-center justify-center gap-2 border border-ember-border bg-transparent px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-text-secondary/80 transition-colors hover:border-ember-border hover:bg-surface-l2 hover:text-text-primary"
                  >
                    View only
                  </button>
                </div>

                <p className="font-mono text-[9px] leading-relaxed text-text-secondary/50">
                  View only disconnects your wallet and lets you browse the
                  terminal without trading. You can connect a different wallet
                  anytime.
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
