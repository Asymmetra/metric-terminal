"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useConnection } from "@solana/wallet-adapter-react";
import { useSigner } from "@/lib/wallet";
import { imperial } from "@/lib/imperial";
import type { PositionLifecycle } from "@/lib/imperial/types";
import { useTraderStore } from "@/stores/traderStore";
import { useStatsStore } from "@/stores/statsStore";
import { useToastStore } from "@/stores/toastStore";
import { buildCloseRequest } from "@/lib/order-builder";
import { closeAndWithdraw, TradeFlowError } from "@/lib/trade-flow";
import { venueOf, sideOf } from "@/lib/position-mapping";
import { confirmSignatureHttp } from "@/lib/solana-rpc";
import { formatPriceAuto, formatUsdPrecise } from "@/lib/format";
import type { FundingEventRow, OrderHistoryRow } from "@/lib/imperial/types";

type Tab = "positions" | "history" | "orders" | "funding";

/** Rows to fetch/show for the read-only order & funding history tabs. */
const HISTORY_LIMIT = 25;

function num(v: string | null): number {
  return v == null ? 0 : Number(v) || 0;
}

/** µUSD string → display dollars. */
function usdFromMicros(v: string | null): number {
  return num(v) / 1e6;
}

/** unix-second timestamp → compact local "MMM D, HH:MM". */
function fmtTime(unixSecs: number | null): string {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Base58 mint → short label ("So11..1112") for a compact market column. */
function shortMint(m: string): string {
  return m.length > 10 ? `${m.slice(0, 4)}..${m.slice(-4)}` : m;
}

export function Positions() {
  const signer = useSigner();
  const wallet = signer.publicKey;
  const { connection } = useConnection();
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

  const runClose = useCallback(
    async (p: PositionLifecycle, withdraw: boolean) => {
      if (!wallet) return;
      setClosing(p.id);
      const tid = addToast("loading", withdraw ? `Closing ${p.asset} & withdrawing…` : `Closing ${p.asset}…`);
      try {
        const token = jwt ?? (await imperial.ensureAuth(signer));
        if (!jwt) setJwt(token);
        const mark = useStatsStore.getState().marks[p.asset] ?? num(p.markPrice);
        const params = {
          wallet,
          profileIndex: p.profileIndex ?? 0,
          symbol: p.asset,
          venue: venueOf(p),
          positionSide: sideOf(p.side),
          sizeUsd: num(p.sizeUsd),
          markPrice: mark,
          slippageBps: 100,
        };
        if (withdraw) {
          const res = await closeAndWithdraw(params, {
            signer,
            jwt: token,
            confirm: (sig) => confirmSignatureHttp(connection, sig),
            onStep: (s) => updateToast(tid, { type: "loading", title: `${p.asset} · close & withdraw`, detail: s.message }),
          });
          updateToast(tid, {
            type: "success",
            title: `${p.asset} closed & withdrawn`,
            detail: res.withdrawnNative > 0 ? `$${(res.withdrawnNative / 1e6).toFixed(2)} → wallet` : "no free balance to withdraw",
            txid: res.withdrawSignature ?? res.close.signature ?? undefined,
          });
        } else {
          const res = await imperial.placeOrder(buildCloseRequest(params), token);
          if (!res.success) throw new Error(res.error ?? "Close rejected");
          updateToast(tid, { type: "success", title: `${p.asset} close submitted`, txid: res.signature ?? undefined });
        }
        bumpRefresh();
      } catch (e) {
        if (e instanceof TradeFlowError && e.closed) {
          // Position closed; only the withdrawal didn't go through (e.g. user
          // rejected the popup). Calm note, not a failure — and refresh so the
          // closed position clears. Funds are safe in the profile.
          updateToast(tid, { type: "info", title: `${p.asset} closed`, detail: e.message });
          bumpRefresh();
        } else {
          updateToast(tid, { type: "error", title: "Close failed", detail: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        setClosing(null);
      }
    },
    [wallet, jwt, signer, connection, setJwt, addToast, updateToast, bumpRefresh]
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
              ["orders", "Orders"],
              ["funding", "Funding"],
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
            <PositionsTable positions={open} closing={closing} onClose={runClose} />
          )
        ) : tab === "history" ? (
          <TradeHistory wallet={wallet} />
        ) : tab === "orders" ? (
          <OrderHistory wallet={wallet} />
        ) : (
          <FundingHistory wallet={wallet} />
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
  onClose: (p: PositionLifecycle, withdraw: boolean) => void;
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
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => onClose(p, true)}
                    disabled={closing === p.id}
                    title="Closes immediately (no signature), then asks you to sign the withdrawal. If you reject that popup, the position stays closed and your funds are safe in the profile."
                    className="border border-metric-border px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-metric-sell/50 hover:text-metric-sell disabled:opacity-40"
                  >
                    {closing === p.id ? "…" : "Close & Withdraw"}
                  </button>
                  <button
                    onClick={() => onClose(p, false)}
                    disabled={closing === p.id}
                    title="Close only — leave the freed balance in the profile to re-trade"
                    className="border border-metric-border px-1.5 py-0.5 text-[10px] text-text-secondary/60 transition-colors hover:text-text-secondary disabled:opacity-40"
                  >
                    Close
                  </button>
                </div>
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

/**
 * Read-only closed/settled order history (GET /order-history, no auth). Compact
 * rows: time · market · action/side · size · status. Paginated to ~25; fails
 * gracefully to an empty state.
 */
function OrderHistory({ wallet }: { wallet: string | null }) {
  const lastRefresh = useTraderStore((s) => s.lastRefresh);
  const [rows, setRows] = useState<OrderHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wallet) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    imperial
      .getOrderHistory(wallet, { limit: HISTORY_LIMIT })
      .then((res) => !cancelled && setRows(res.orders ?? []))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [wallet, lastRefresh]);

  if (!wallet) return <Empty>Connect a wallet to see orders</Empty>;
  if (loading && rows.length === 0) return <Empty>Loading…</Empty>;
  if (rows.length === 0) return <Empty>No orders yet</Empty>;

  return (
    <table className="w-full font-mono text-[11px]">
      <thead className="sticky top-0 bg-surface-1 text-left text-text-secondary/60">
        <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
          <th>Time</th>
          <th>Market</th>
          <th>Action</th>
          <th>Type</th>
          <th>Size</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => {
          const side = o.side?.toLowerCase();
          const isLong = side === "long" || side === "buy" || side === "0";
          return (
            <tr key={o.orderPda} className="border-t border-metric-border/40 [&>td]:px-3 [&>td]:py-1.5">
              <td className="text-text-secondary/70">{fmtTime(o.executedAt ?? o.createdAt)}</td>
              <td className="text-text-primary">{shortMint(o.marketMint)}</td>
              <td className={isLong ? "text-metric-buy" : "text-metric-sell"}>
                {o.action} {o.side}
              </td>
              <td className="text-text-secondary">{o.orderType}</td>
              <td className="text-text-secondary">${formatPriceAuto(usdFromMicros(o.sizeUsd))}</td>
              <td className="text-text-secondary/80">{o.displayStatus || o.status}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Read-only funding/borrow settlement history (GET /funding-history, no auth).
 * Compact rows: time · symbol · type · amount (positive = paid, red; received
 * = green). Paginated to ~25; fails gracefully to an empty state.
 */
function FundingHistory({ wallet }: { wallet: string | null }) {
  const lastRefresh = useTraderStore((s) => s.lastRefresh);
  const [rows, setRows] = useState<FundingEventRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wallet) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    imperial
      .getFundingHistory(wallet, { limit: HISTORY_LIMIT })
      .then((res) => !cancelled && setRows(res.events ?? []))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [wallet, lastRefresh]);

  if (!wallet) return <Empty>Connect a wallet to see funding</Empty>;
  if (loading && rows.length === 0) return <Empty>Loading…</Empty>;
  if (rows.length === 0) return <Empty>No funding events yet</Empty>;

  return (
    <table className="w-full font-mono text-[11px]">
      <thead className="sticky top-0 bg-surface-1 text-left text-text-secondary/60">
        <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
          <th>Time</th>
          <th>Market</th>
          <th>Side</th>
          <th>Type</th>
          <th>Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => {
          // amount is signed µUSD; positive = trader PAID (cost, red).
          const amt = usdFromMicros(f.amount);
          const side = f.side?.toLowerCase();
          return (
            <tr key={f.id} className="border-t border-metric-border/40 [&>td]:px-3 [&>td]:py-1.5">
              <td className="text-text-secondary/70">{fmtTime(f.eventAt)}</td>
              <td className="text-text-primary">{f.symbol || shortMint(f.marketMint)}</td>
              <td className={side === "long" ? "text-metric-buy" : side === "short" ? "text-metric-sell" : "text-text-secondary"}>
                {f.side || "—"}
              </td>
              <td className="text-text-secondary/80">{f.eventType.replace("_settled", "")}</td>
              <td className={amt > 0 ? "text-metric-sell" : "text-metric-buy"}>
                {amt > 0 ? "-" : amt < 0 ? "+" : ""}
                {formatUsdPrecise(Math.abs(amt))}
              </td>
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
