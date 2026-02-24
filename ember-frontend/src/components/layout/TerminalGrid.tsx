"use client";

import { ReactNode } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";

interface TerminalGridProps {
  orderbook: ReactNode;
  chart: ReactNode;
  orderEntry: ReactNode;
  tradeHistory: ReactNode;
  positions: ReactNode;
}

function ResizeHandle({ direction = "vertical" }: { direction?: "vertical" | "horizontal" }) {
  return (
    <Separator
      className={
        direction === "vertical"
          ? "w-px bg-ember-border hover:bg-ember-orange/40 transition-colors data-[separator=active]:bg-ember-orange/60"
          : "h-px bg-ember-border hover:bg-ember-orange/40 transition-colors data-[separator=active]:bg-ember-orange/60"
      }
    />
  );
}

export function TerminalGrid({
  orderbook,
  chart,
  orderEntry,
  tradeHistory,
  positions,
}: TerminalGridProps) {
  return (
    <Group orientation="vertical" className="flex-1 overflow-hidden">
      {/* Top row: orderbook | chart+order | trades */}
      <Panel defaultSize="70%" minSize="40%">
        <Group orientation="horizontal" className="h-full">
          {/* Left: Orderbook */}
          <Panel defaultSize="20%" minSize="12%" maxSize="35%">
            <div className="h-full bg-surface-l1 overflow-hidden">{orderbook}</div>
          </Panel>

          <ResizeHandle direction="vertical" />

          {/* Center: Chart + Order Entry */}
          <Panel defaultSize="55%" minSize="30%">
            <div className="h-full bg-surface-l1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-hidden">{chart}</div>
              <div className="border-t border-ember-border">{orderEntry}</div>
            </div>
          </Panel>

          <ResizeHandle direction="vertical" />

          {/* Right: Trade History */}
          <Panel defaultSize="25%" minSize="12%" maxSize="35%">
            <div className="h-full bg-surface-l1 overflow-hidden">{tradeHistory}</div>
          </Panel>
        </Group>
      </Panel>

      <ResizeHandle direction="horizontal" />

      {/* Bottom: Positions */}
      <Panel defaultSize="30%" minSize="15%" maxSize="50%">
        <div className="h-full bg-surface-l1 overflow-hidden">{positions}</div>
      </Panel>
    </Group>
  );
}
