"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTraderStore } from "@/stores/traderStore";
import { api } from "@/lib/api";
import clsx from "clsx";

// Invite-gated onboarding dialog. Shown when:
//   connected && noAccount === true && inviteActivated === false && !onboardingDismissed
//
// Two activation paths per the rise-public SDK README — these routes are NOT
// interchangeable, so we let the user pick which code type they have:
//   • Referral code  → POST /api/onboard/activate-referral  (forwards as referral_code)
//   • Access code    → POST /api/onboard/activate-access-code (forwards as code)
//
// "Browse anyway" dismisses the modal for the rest of the session without
// disconnecting the wallet — the user can read markets, view positions, etc.
// Trade attempts will surface a Phoenix activation error until they activate.
//
// "Disconnect wallet" returns to the fully read-only disconnected state and
// lets the user connect a different (already-onboarded) wallet.

type CodeType = "referral" | "access";

export function OnboardingModal() {
  const { connected, publicKey, disconnect } = useWallet();
  const noAccount = useTraderStore((s) => s.noAccount);
  const inviteActivated = useTraderStore((s) => s.inviteActivated);
  const onboardingDismissed = useTraderStore((s) => s.onboardingDismissed);
  const setInviteActivated = useTraderStore((s) => s.setInviteActivated);
  const setOnboardingDismissed = useTraderStore((s) => s.setOnboardingDismissed);

  const [codeType, setCodeType] = useState<CodeType>("referral");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shouldOpen =
    !!connected &&
    !!publicKey &&
    noAccount === true &&
    inviteActivated === false &&
    !onboardingDismissed;

  // Reset transient fields whenever the modal closes so reopening is clean.
  useEffect(() => {
    if (!shouldOpen) {
      setCode("");
      setError(null);
      setSubmitting(false);
    }
  }, [shouldOpen]);

  async function handleActivate() {
    if (!publicKey) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setError(codeType === "referral" ? "Referral code is required" : "Access code is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const pk = publicKey.toBase58();
      const res =
        codeType === "referral"
          ? await api.activateReferral(pk, trimmed)
          : await api.activateAccessCode(pk, trimmed);
      // already_activated === true means the wallet was previously onboarded;
      // still a success from the user's POV.
      setInviteActivated(true);
      void res; // Currently unused; future: show a "Welcome!" toast on first activation
    } catch (e: any) {
      const msg = typeof e?.message === "string" ? e.message : "";
      // Backend prefixes recoverable errors as "invalid_code:..." or
      // "upstream_error:...". Anything else is shown as-is.
      if (msg.startsWith("invalid_code:")) {
        setError(
          codeType === "referral"
            ? "Invalid referral code. Double-check and try again, or switch to Access code."
            : "Invalid access code. Double-check and try again, or switch to Referral code."
        );
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

  function handleBrowseAnyway() {
    // Dismiss the modal but keep the wallet connected. Trader state stays in
    // its "no Phoenix account" shape; trade attempts will surface a Phoenix
    // activation error from the backend.
    setOnboardingDismissed(true);
  }

  function handleDisconnect() {
    // Return to the disconnected state. The terminal is read-only without a
    // wallet connection.
    disconnect().catch(() => {});
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !submitting) {
      e.preventDefault();
      handleActivate();
    }
  }

  function switchType(next: CodeType) {
    if (next === codeType) return;
    setCodeType(next);
    setError(null);
  }

  const codeLabel = codeType === "referral" ? "Referral code" : "Access code";
  const placeholder = codeType === "referral" ? "EMBER-XXXX" : "Enter access code";

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
            <div className="w-full max-w-[440px] border border-metric-border bg-surface-1 shadow-[0_16px_64px_rgba(0,0,0,0.6)]">
              <div className="border-b border-metric-border/60 px-5 py-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-metric-primary">
                  Welcome to Ember
                </span>
              </div>

              <div className="flex flex-col gap-4 px-5 py-5">
                <p className="font-mono text-[11px] leading-relaxed text-text-secondary">
                  Ember is in invite-only beta. Activate this wallet with a
                  referral code from another trader, or an access code from the
                  Ember team.
                </p>

                <div
                  role="tablist"
                  aria-label="Activation method"
                  className="flex border border-metric-border bg-surface-2 p-0.5"
                >
                  {(["referral", "access"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={codeType === t}
                      onClick={() => switchType(t)}
                      disabled={submitting}
                      className={clsx(
                        "flex-1 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                        codeType === t
                          ? "bg-metric-primary/15 text-metric-primary"
                          : "text-text-secondary/70 hover:text-text-primary"
                      )}
                    >
                      {t === "referral" ? "Referral code" : "Access code"}
                    </button>
                  ))}
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-text-secondary/60">
                    {codeLabel}
                  </span>
                  <input
                    type="text"
                    autoFocus
                    value={code}
                    onChange={(e) => {
                      // Don't transform — invite codes may be case-sensitive.
                      setCode(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={handleKey}
                    disabled={submitting}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={placeholder}
                    className={clsx(
                      "w-full border bg-metric-bg px-3 py-2 font-mono text-[13px] tracking-wider text-text-primary outline-none transition-colors",
                      error
                        ? "border-metric-sell/70 focus:border-metric-sell"
                        : "border-metric-border focus:border-metric-primary/70"
                    )}
                  />
                  {error && (
                    <span className="font-mono text-[10px] text-metric-sell">
                      {error}
                    </span>
                  )}
                </label>

                <button
                  onClick={handleActivate}
                  disabled={submitting || code.trim().length === 0}
                  className={clsx(
                    "flex items-center justify-center gap-2 border px-4 py-2 font-mono text-[11px] uppercase tracking-wider transition-colors",
                    submitting || code.trim().length === 0
                      ? "cursor-not-allowed border-metric-border bg-surface-2 text-text-secondary/40"
                      : "border-metric-primary bg-metric-primary/15 text-metric-primary hover:bg-metric-primary/25"
                  )}
                >
                  {submitting ? "Activating…" : "Activate & continue"}
                </button>

                <div className="border-t border-metric-border/60 pt-4">
                  <p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-text-secondary/60">
                    No code yet?
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleBrowseAnyway}
                      disabled={submitting}
                      className="flex items-center justify-center gap-2 border border-metric-border bg-transparent px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/80 transition-colors hover:border-metric-border hover:bg-surface-2 hover:text-text-primary"
                    >
                      Browse anyway
                    </button>
                    <button
                      onClick={handleDisconnect}
                      disabled={submitting}
                      className="flex items-center justify-center gap-2 border border-metric-border bg-transparent px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/80 transition-colors hover:border-metric-border hover:bg-surface-2 hover:text-text-primary"
                    >
                      Disconnect wallet
                    </button>
                  </div>
                  <p className="mt-2 font-mono text-[9px] leading-relaxed text-text-secondary/50">
                    Browse anyway lets you read markets and prices without
                    trading. Disconnect returns the terminal to read-only and
                    lets you connect a different wallet.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
