"use client";

import { useState, useEffect } from "react";
import { TerminalGrid } from "@/components/layout/TerminalGrid";
import { MarketHeader } from "@/components/terminal/MarketHeader";
import { MarketDataPanel } from "@/components/terminal/MarketDataPanel";
import { Orderbook } from "@/components/terminal/Orderbook";
import { Chart } from "@/components/terminal/Chart";
import { TradeHistory } from "@/components/terminal/TradeHistory";
import { OrderEntry } from "@/components/terminal/OrderEntry";
import { Positions } from "@/components/terminal/Positions";
import { ConnectionStatus } from "@/components/shared/ConnectionStatus";
import { Toasts } from "@/components/shared/Toasts";
import { TradeDetailPanel } from "@/components/terminal/TradeDetailPanel";
import { KeyboardShortcutOverlay } from "@/components/terminal/KeyboardShortcutOverlay";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { DepthChart } from "@/components/terminal/DepthChart";

const ACCESS_KEY = "ember-access";
const PASSCODE = "getrekt";

function AccessGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [shaking, setShaking] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value === PASSCODE) {
      sessionStorage.setItem(ACCESS_KEY, "1");
      onUnlock();
    } else {
      setError(true);
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ember-black">
      <form
        onSubmit={handleSubmit}
        className={`flex flex-col items-center gap-5 ${shaking ? "animate-shake" : ""}`}
      >
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 bg-ember-orange" style={{ boxShadow: "0 0 8px rgba(255,85,0,0.4)" }} />
          <span className="font-mono text-[11px] tracking-[0.35em] text-text-secondary/70 uppercase">
            Ember Terminal
          </span>
        </div>

        <h2 className="font-mono text-lg font-medium tracking-wider text-text-primary uppercase">
          Access Required
        </h2>

        <div className="relative">
          <input
            type="password"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(false); }}
            placeholder="Enter passcode"
            autoFocus
            className="w-64 border border-ember-border bg-surface-l1 py-2.5 px-4 font-mono text-sm text-text-primary placeholder:text-text-secondary/30 focus:border-ember-orange/60 focus:outline-none transition-colors text-center tracking-widest"
          />
        </div>

        {error && (
          <span className="font-mono text-[10px] text-ember-red tracking-wider">
            Invalid passcode
          </span>
        )}

        <button
          type="submit"
          className="border border-ember-orange/60 bg-transparent px-8 py-2.5 font-mono text-[11px] font-medium tracking-[0.2em] text-ember-orange uppercase transition-all duration-300 hover:border-ember-orange hover:bg-ember-orange/10"
          style={{ boxShadow: "0 0 20px rgba(255,85,0,0.08)" }}
        >
          Enter
        </button>
      </form>
    </div>
  );
}

export default function TerminalPage() {
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(ACCESS_KEY) === "1");
    setChecked(true);
  }, []);

  if (!checked) return null;

  if (!authed) {
    return <AccessGate onUnlock={() => setAuthed(true)} />;
  }

  useKeyboardShortcuts();

  return (
    <div className="flex h-full flex-col">
      <ConnectionStatus />
      <MarketHeader />
      <TerminalGrid
        marketData={
          <MarketDataPanel
            orderbook={<Orderbook />}
            tradeHistory={<TradeHistory />}
            depthChart={<DepthChart />}
          />
        }
        chart={<Chart />}
        orderEntry={<OrderEntry />}
        positions={<Positions />}
      />
      <Toasts />
      <TradeDetailPanel />
      <KeyboardShortcutOverlay />
    </div>
  );
}
