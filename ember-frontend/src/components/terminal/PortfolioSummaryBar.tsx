"use client";

import { useTraderStore } from "@/stores/traderStore";
import { formatUsd } from "@/lib/format";
import clsx from "clsx";

export function PortfolioSummaryBar() {
  const connected = useTraderStore((s) => s.connected);
  const collateral = useTraderStore((s) => s.collateral);
  const portfolioValue = useTraderStore((s) => s.portfolioValue);
  const unrealizedPnl = useTraderStore((s) => s.unrealizedPnl);
  const initialMargin = useTraderStore((s) => s.initialMargin);
  const maintenanceMargin = useTraderStore((s) => s.maintenanceMargin);
  const riskState = useTraderStore((s) => s.riskState);

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
      <SummaryItem label="Portfolio" value={formatUsd(portfolioValue)} />
      <SummaryItem
        label="Unreal. PnL"
        value={`${unrealizedPnl >= 0 ? "+" : ""}${formatUsd(unrealizedPnl)}`}
        colorClass={unrealizedPnl >= 0 ? "text-ember-green" : "text-ember-red"}
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
