"use client";

import { ReactNode } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";

interface TerminalGridProps {
  marketData: ReactNode;
  chart: ReactNode;
  orderEntry: ReactNode;
  positions: ReactNode;
}

function ResizeHandle({ direction = "vertical" }: { direction?: "vertical" | "horizontal" }) {
  return (
    <Separator
      className={
        direction === "vertical"
          ? "w-px bg-metric-border transition-colors hover:bg-metric-primary/40 data-[separator=active]:bg-metric-primary/60"
          : "h-px bg-metric-border transition-colors hover:bg-metric-primary/40 data-[separator=active]:bg-metric-primary/60"
      }
    />
  );
}

export function TerminalGrid({ marketData, chart, orderEntry, positions }: TerminalGridProps) {
  return (
    <Group orientation="vertical" className="flex-1 overflow-hidden">
      {/* Top row: market data | chart | order entry */}
      <Panel defaultSize="70%" minSize="40%">
        <Group orientation="horizontal" className="h-full">
          <Panel defaultSize="22%" minSize="14%" maxSize="35%">
            <div className="h-full overflow-hidden bg-surface-1">{marketData}</div>
          </Panel>

          <ResizeHandle direction="vertical" />

          <Panel defaultSize="53%" minSize="30%">
            <div className="h-full overflow-hidden bg-surface-1">{chart}</div>
          </Panel>

          <ResizeHandle direction="vertical" />

          <Panel defaultSize="25%" minSize="18%" maxSize="38%">
            <div className="h-full overflow-auto bg-surface-1">{orderEntry}</div>
          </Panel>
        </Group>
      </Panel>

      <ResizeHandle direction="horizontal" />

      {/* Bottom: positions */}
      <Panel defaultSize="30%" minSize="15%" maxSize="50%">
        <div className="h-full overflow-hidden bg-surface-1">{positions}</div>
      </Panel>
    </Group>
  );
}
