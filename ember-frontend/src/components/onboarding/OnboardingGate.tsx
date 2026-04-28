"use client";

import { useTraderSync } from "@/hooks/useTraderSync";
import { OnboardingModal } from "./OnboardingModal";

// Thin client component mounted once at the root layout. Runs useTraderSync
// globally (so trader state is kept in sync whether the user is on /terminal,
// /profile, /leaderboard, etc.) and renders the invite-gate modal on top of
// every page when needed.
//
// Before this existed, useTraderSync ran only inside MarketHeader which meant
// the onboarding check only fired on /terminal. Centralizing it here keeps
// the sync lifecycle single-sourced and the modal universally available.
export function OnboardingGate() {
  useTraderSync();
  return <OnboardingModal />;
}
