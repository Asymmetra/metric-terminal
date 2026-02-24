"use client";

import { TerminalGrid } from "@/components/layout/TerminalGrid";
import { MarketHeader } from "@/components/terminal/MarketHeader";
import { Orderbook } from "@/components/terminal/Orderbook";
import { Chart } from "@/components/terminal/Chart";
import { TradeHistory } from "@/components/terminal/TradeHistory";
import { OrderEntry } from "@/components/terminal/OrderEntry";
import { Positions } from "@/components/terminal/Positions";
import { ConnectionStatus } from "@/components/shared/ConnectionStatus";
import { Toasts } from "@/components/shared/Toasts";

export default function TerminalPage() {
  return (
    <div className="flex h-full flex-col">
      <ConnectionStatus />
      <MarketHeader />
      <TerminalGrid
        orderbook={<Orderbook />}
        chart={<Chart />}
        orderEntry={<OrderEntry />}
        tradeHistory={<TradeHistory />}
        positions={<Positions />}
      />
      <Toasts />
    </div>
  );
}
