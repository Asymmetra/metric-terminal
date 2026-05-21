"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useSigner } from "@/lib/wallet";
import { imperial } from "@/lib/imperial";
import type { PositionLifecycle, VenueTag } from "@/lib/imperial/types";
import { useTraderStore } from "@/stores/traderStore";
import { useStatsStore } from "@/stores/statsStore";
import { useToastStore } from "@/stores/toastStore";
import { buildCloseRequest } from "@/lib/order-builder";
import { formatPriceAuto, formatUsdPrecise } from "@/lib/format";

type Tab = "positions" | "history";

function venueOf(underwriter: string): VenueTag {
  const u = underwriter.toLowerCase();
  if (u.includes("jupiter")) return "jupiter";
  if (u.includes("flash")) return "flash_trade";
  if (u.includes("gm")) return "gmtrade";
  return "phoenix";
}
function sideOf(side: string): "long" | "short" {
  return side.toLowerCase().includes("short") ? "short" : "long";
}
function num(v: string | null): number {
  return v == null ? 0 : Number(v) || 0;
}

export function Positions() {
  const signer = useSigner();
  const wallet = signer.publicKey;
  const [tab, setTab] = useState<Tab>("positions");

  const positions = useTraderStore((s) => s.positions);
  const balances = useTraderStore((s) => s.balances);
  const jwt = useTraderStore((s) => s.jwt);
  const setJwt = useTraderStore((s) => s.setJwt);
  const bumpRefresh = useTraderStore((s) => s.bumpRefresh);
  const addToast = useToastStore((s) => s.addToast);
  const updateToast = useToastStore((s) => s.updateToast);

  const open = useMemo(
    () => positions.filter((p) => p.status?.toLowerCase() === "open" || num(p.sizeUsd) > 0),
    [positions]
  );

  const [closing, setClosing] = useState<string | null>(null);

  const closePosition = useCallback(
    async (p: PositionLifecycle) => {
      if (!wallet) return;
      setClosing(p.id);
      const tid = addToast("loading", `Closing ${p.asset}…`);
      try {
        const token = jwt ?? (await imperial.ensureAuth(signer));
        if (!jwt) setJwt(token);
        const mark = useStatsStore.getState().marks[p.asset] ?? num(p.markPrice);
        const res = await imperial.placeOrder(
          buildCloseRequest({
            wallet,
            profileIndex: p.profileIndex ?? 0,
            symbol: p.asset,
            venue: venueOf(p.underwriter),
            positionSide: sideOf(p.side),
            sizeUsd: num(p.sizeUsd),
            markPrice: mark,
            slippageBps: 100,
          }),
          token
        );
        if (!res.success) throw new Error(res.error ?? "Close rejected");
        updateToast(tid, { type: "success", title: `${p.asset} close submitted`, txid: res.signature ?? undefined });
        bumpRefresh();
      } catch (e) {
        updateToast(tid, { type: "error", title: "Close failed", detail: e instanceof Error ? e.message : String(e) });
      } finally {
        setClosing(null);
      }
    },
    [wallet, jwt, signer, setJwt, addToast, updateToast, bumpRefresh]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar + account footer */}
      <div className="flex items-center justify-between border-b border-metric-border bg-surface-1 px-3">
        <div className="flex">
          {(
            [
              ["positions", `Positions (${open.length})`],
              ["history", "Trade History"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={clsx(
                "relative px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition-colors",
                tab === key ? "text-metric-primary" : "text-text-secondary/60 hover:text-text-secondary"
              )}
            >
              {label}
              {tab === key && <span className="absolute inset-x-0 top-0 h-0.5 bg-metric-primary" />}
            </button>
          ))}
        </div>
        <AccountSummary />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "positions" ? (
          open.length === 0 ? (
            <Empty>{wallet ? "No open positions" : "Connect a wallet to see positions"}</Empty>
          ) : (
            <PositionsTable positions={open} closing={closing} onClose={closePosition} />
          )
        ) : (
          <TradeHistory wallet={wallet} />
        )}
      </div>

      {balances.length > 0 && (
        <div className="flex items-center gap-3 overflow-x-auto border-t border-metric-border bg-surface-1 px-3 py-1.5 font-mono text-[10px] scrollbar-hide">
          <span className="text-text-secondary/60">Profiles:</span>
          {balances.map((b) => (
            <span key={b.profileIndex} className="whitespace-nowrap text-text-secondary">
              {b.profileIndex}: <span className="text-text-primary">${(b.usdc / 1e6).toFixed(2)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PositionsTable({
  positions,
  closing,
  onClose,
}: {
  positions: PositionLifecycle[];
  closing: string | null;
  onClose: (p: PositionLifecycle) => void;
}) {
  return (
    <table className="w-full font-mono text-[11px]">
      <thead className="sticky top-0 bg-surface-1 text-left text-text-secondary/60">
        <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
          <th>Market</th>
          <th>Side</th>
          <th>Size</th>
          <th>Collateral</th>
          <th>Entry</th>
          <th>Mark</th>
          <th>Liq.</th>
          <th>PnL</th>
          <th>Lev</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const side = sideOf(p.side);
          const pnl = num(p.pnlUsd);
          return (
            <tr key={p.id} className="border-t border-metric-border/40 [&>td]:px-3 [&>td]:py-1.5">
              <td className="text-text-primary">{p.asset}</td>
              <td className={side === "long" ? "text-metric-buy" : "text-metric-sell"}>
                {side === "long" ? "Long" : "Short"}
              </td>
              <td className="text-text-primary">${formatPriceAuto(num(p.sizeUsd))}</td>
              <td className="text-text-secondary">${formatPriceAuto(num(p.collateralUsd))}</td>
              <td className="text-text-secondary">{p.entryPrice ? `$${formatPriceAuto(num(p.entryPrice))}` : "—"}</td>
              <td className="text-text-secondary">{p.markPrice ? `$${formatPriceAuto(num(p.markPrice))}` : "—"}</td>
              <td className="text-text-secondary">{p.liquidationPrice ? `$${formatPriceAuto(num(p.liquidationPrice))}` : "—"}</td>
              <td className={pnl >= 0 ? "text-metric-buy" : "text-metric-sell"}>{formatUsdPrecise(pnl)}</td>
              <td className="text-text-secondary">{p.leverageX ? `${num(p.leverageX).toFixed(1)}x` : "—"}</td>
              <td className="text-right">
                <button
                  onClick={() => onClose(p)}
                  disabled={closing === p.id}
                  className="border border-metric-border px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-metric-sell/50 hover:text-metric-sell disabled:opacity-40"
                >
                  {closing === p.id ? "…" : "Close"}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TradeHistory({ wallet }: { wallet: string | null }) {
  const lastRefresh = useTraderStore((s) => s.lastRefresh);
  const [rows, setRows] = useState<PositionLifecycle[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wallet) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    imperial
      .getTrades(wallet, { limit: 50 })
      .then((res) => !cancelled && setRows(res.dataList ?? []))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [wallet, lastRefresh]);

  if (!wallet) return <Empty>Connect a wallet to see trade history</Empty>;
  if (loading && rows.length === 0) return <Empty>Loading…</Empty>;
  if (rows.length === 0) return <Empty>No trades yet</Empty>;

  return (
    <table className="w-full font-mono text-[11px]">
      <thead className="sticky top-0 bg-surface-1 text-left text-text-secondary/60">
        <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
          <th>Market</th>
          <th>Side</th>
          <th>Size</th>
          <th>Entry</th>
          <th>Status</th>
          <th>PnL</th>
          <th>Opened</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const side = sideOf(p.side);
          const pnl = num(p.pnlUsd);
          return (
            <tr key={p.id} className="border-t border-metric-border/40 [&>td]:px-3 [&>td]:py-1.5">
              <td className="text-text-primary">{p.asset}</td>
              <td className={side === "long" ? "text-metric-buy" : "text-metric-sell"}>{side === "long" ? "Long" : "Short"}</td>
              <td className="text-text-secondary">${formatPriceAuto(num(p.sizeUsd))}</td>
              <td className="text-text-secondary">{p.entryPrice ? `$${formatPriceAuto(num(p.entryPrice))}` : "—"}</td>
              <td className="text-text-secondary">{p.status}</td>
              <td className={pnl >= 0 ? "text-metric-buy" : "text-metric-sell"}>{formatUsdPrecise(pnl)}</td>
              <td className="text-text-secondary/70">{p.openedAt ? new Date(p.openedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AccountSummary() {
  const balances = useTraderStore((s) => s.balances);
  const total = balances.reduce((a, b) => a + b.usdc / 1e6, 0);
  if (balances.length === 0) return null;
  return (
    <span className="font-mono text-[10px] text-text-secondary">
      Equity: <span className="text-text-primary">${total.toFixed(2)}</span>
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-text-secondary/50">
      {children}
    </div>
  );
}
