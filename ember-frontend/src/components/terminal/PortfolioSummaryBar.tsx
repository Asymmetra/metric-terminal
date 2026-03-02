"use client";

import { useMemo } from "react";
import { useTraderStore } from "@/stores/traderStore";
import { useStatsStore } from "@/stores/statsStore";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

export function PortfolioSummaryBar() {
  const connected = useTraderStore((s) => s.connected);
  const collateral = useTraderStore((s) => s.collateral);
  const positions = useTraderStore((s) => s.positions);
  const initialMargin = useTraderStore((s) => s.initialMargin);
  const maintenanceMargin = useTraderStore((s) => s.maintenanceMargin);
  const riskState = useTraderStore((s) => s.riskState);
  const markPrices = useStatsStore((s) => s.markPrices);

  // Compute live unrealized PnL from current mark prices (not stale REST snapshot)
  const liveUnrealizedPnl = useMemo(() => {
    let total = 0;
    for (const pos of positions) {
      const mark = markPrices[pos.symbol] ?? pos.mark_price;
      if (mark > 0 && pos.entry_price > 0) {
        const isLong = pos.side.toLowerCase() === "long";
        total += isLong
          ? (mark - pos.entry_price) * pos.size
          : (pos.entry_price - mark) * pos.size;
      } else {
        total += pos.unrealized_pnl;
      }
    }
    return total;
  }, [positions, markPrices]);

  // Live portfolio value = collateral + live unrealized PnL
  const livePortfolioValue = collateral + liveUnrealizedPnl;

  if (!connected) return null;

  const marginUsage = collateral > 0 ? (initialMargin / collateral) * 100 : 0;
  const healthColor =
    riskState === "Healthy" || riskState === "ZeroCollateralNoPositions"
      ? "text-ember-green"
      : riskState === "BeingLiquidated"
        ? "text-ember-red"
        : "text-yellow-500";
  const healthLabel =
    riskState === "ZeroCollateralNoPositions" ? "No Positions" : riskState || "—";

  return (
    <div className="flex items-center gap-4 border-b border-ember-border/50 bg-surface-l1/50 px-3 py-1">
      <SummaryItem label="Collateral" value={formatUsd(collateral)} />
      <SummaryItem label="Portfolio" value={formatUsd(livePortfolioValue)} />
      <SummaryItem
        label="Unreal. PnL"
        value={`${liveUnrealizedPnl >= 0 ? "+" : ""}${formatUsd(liveUnrealizedPnl)}`}
        colorClass={liveUnrealizedPnl >= 0 ? "text-ember-green" : "text-ember-red"}
      />
      <SummaryItem
        label="Margin Usage"
        value={`${marginUsage.toFixed(1)}%`}
        colorClass={marginUsage > 80 ? "text-ember-red" : marginUsage > 50 ? "text-yellow-500" : "text-text-secondary"}
      />
      <SummaryItem
        label="Maint. Margin"
        value={formatUsd(maintenanceMargin)}
      />
      <SummaryItem label="Health" value={healthLabel} colorClass={healthColor} />
    </div>
  );
}

function SummaryItem({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: string;
  colorClass?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-text-secondary/50">
        {label}
      </span>
      <span
        className={clsx(
          "font-mono text-[10px]",
          colorClass || "text-text-secondary"
        )}
      >
        {value}
      </span>
    </div>
  );
}
