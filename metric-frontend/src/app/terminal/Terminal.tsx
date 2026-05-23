"use client";

import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { TerminalGrid } from "@/components/layout/TerminalGrid";
import { MarketHeader } from "@/components/terminal/MarketHeader";
import { Chart } from "@/components/terminal/Chart";
import { MarketDepthPanel } from "@/components/terminal/MarketDepthPanel";
import { OrderEntry } from "@/components/terminal/OrderEntry";
import { Positions } from "@/components/terminal/Positions";
import { ConnectionStatus } from "@/components/shared/ConnectionStatus";
import { Toasts } from "@/components/shared/Toasts";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTraderSync } from "@/hooks/useTraderSync";
import { marketData } from "@/lib/market-data";
import { useMarketStore } from "@/stores/marketStore";
import { useUiStore } from "@/stores/uiStore";
import clsx from "clsx";

/** Mount the market-data feed + keep the depth subscription on the selected symbol. */
function useMarketFeed() {
  const selected = useMarketStore((s) => s.selectedSymbol);
  useEffect(() => {
    marketData.start();
    return () => marketData.stop();
  }, []);
  useEffect(() => {
    marketData.setDepthSymbol(selected);
  }, [selected]);
}

function DesktopTerminal() {
  return (
    <div className="flex h-full flex-col">
      <ConnectionStatus />
      <MarketHeader />
      <TerminalGrid
        marketData={<ErrorBoundary name="Order Book"><MarketDepthPanel /></ErrorBoundary>}
        chart={<ErrorBoundary name="Chart"><Chart /></ErrorBoundary>}
        orderEntry={<ErrorBoundary name="Order Entry"><OrderEntry /></ErrorBoundary>}
        positions={<ErrorBoundary name="Positions"><Positions /></ErrorBoundary>}
      />
      <Toasts />
    </div>
  );
}

function MobileTerminal() {
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const tabs = [
    { key: "book" as const, label: "Book" },
    { key: "trade" as const, label: "Trade" },
    { key: "positions" as const, label: "Positions" },
  ];

  return (
    <div className="flex h-dvh flex-col">
      <ConnectionStatus />
      <MarketHeader />
      <div className="h-[38vh] border-b border-metric-border">
        <ErrorBoundary name="Chart"><Chart /></ErrorBoundary>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mobileTab === "book" && <ErrorBoundary name="Order Book"><MarketDepthPanel /></ErrorBoundary>}
        {mobileTab === "trade" && <ErrorBoundary name="Order Entry"><OrderEntry /></ErrorBoundary>}
        {mobileTab === "positions" && <ErrorBoundary name="Positions"><Positions /></ErrorBoundary>}
      </div>
      <div className="flex h-12 border-t border-metric-border bg-surface-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setMobileTab(tab.key)}
            className={clsx(
              "relative flex flex-1 items-center justify-center font-mono text-[11px] uppercase tracking-wider transition-colors",
              mobileTab === tab.key ? "text-metric-primary" : "text-text-secondary/60"
            )}
          >
            {tab.label}
            {mobileTab === tab.key && <div className="absolute inset-x-0 top-0 h-0.5 bg-metric-primary" />}
          </button>
        ))}
      </div>
      <Toasts />
    </div>
  );
}

export default function Terminal() {
  const isMobile = useIsMobile();
  const { publicKey } = useWallet();
  useMarketFeed();
  useTraderSync(publicKey ? publicKey.toBase58() : null);

  return isMobile ? <MobileTerminal /> : <DesktopTerminal />;
}
