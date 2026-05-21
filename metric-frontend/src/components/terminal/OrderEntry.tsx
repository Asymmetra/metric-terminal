"use client";

import { useCallback, useMemo, useState } from "react";
import clsx from "clsx";
import { useSigner } from "@/lib/wallet";
import { imperial } from "@/lib/imperial";
import { ImperialError } from "@/lib/imperial/client";
import type { VenueTag } from "@/lib/imperial/types";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { useToastStore } from "@/stores/toastStore";
import {
  buildOrderRequest,
  impliedLeverage,
  validateOrder,
  MIN_COLLATERAL_USD,
  type OrderFormInput,
} from "@/lib/order-builder";
import { formatPriceAuto } from "@/lib/format";

const VENUES: { tag: VenueTag; label: string }[] = [
  { tag: "phoenix", label: "Phoenix" },
  { tag: "jupiter", label: "Jupiter" },
  { tag: "flash_trade", label: "Flash" },
  { tag: "gmtrade", label: "GMTrade" },
];
const LEVERAGE_PRESETS = [2, 5, 10, 25];

function Field({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">{label}</span>
        {right}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full border border-metric-border bg-metric-bg px-2 py-1.5 font-mono text-sm text-text-primary outline-none focus:border-metric-primary/60";

export function OrderEntry() {
  const signer = useSigner();
  const wallet = signer.publicKey;

  const symbol = useMarketStore((s) => s.selectedSymbol);
  const mark = useStatsStore((s) => s.marks[symbol]);

  const jwt = useTraderStore((s) => s.jwt);
  const setJwt = useTraderStore((s) => s.setJwt);
  const balances = useTraderStore((s) => s.balances);
  const setBalances = useTraderStore((s) => s.setBalances);
  const bumpRefresh = useTraderStore((s) => s.bumpRefresh);

  const addToast = useToastStore((s) => s.addToast);
  const updateToast = useToastStore((s) => s.updateToast);

  const [venue, setVenue] = useState<VenueTag>("phoenix");
  const [type, setType] = useState<"market" | "limit">("market");
  const [profileIndex, setProfileIndex] = useState(0);
  const [collateral, setCollateral] = useState("");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [busy, setBusy] = useState(false);
  const [depositAmt, setDepositAmt] = useState("");

  const profileBalance = useMemo(() => {
    const p = balances.find((b) => b.profileIndex === profileIndex);
    return p ? p.usdc / 1e6 : 0;
  }, [balances, profileIndex]);

  const collateralNum = Number(collateral) || 0;
  const sizeNum = Number(size) || 0;
  const lev = impliedLeverage(sizeNum, collateralNum);

  const refreshBalances = useCallback(
    async (token: string) => {
      try {
        const res = await imperial.getBalances(token);
        setBalances(res.profiles ?? []);
      } catch {
        /* ignore */
      }
    },
    [setBalances]
  );

  const ensureJwt = useCallback(async (): Promise<string> => {
    if (jwt) return jwt;
    const token = await imperial.ensureAuth(signer);
    setJwt(token);
    void refreshBalances(token);
    return token;
  }, [jwt, signer, setJwt, refreshBalances]);

  const handleAuth = useCallback(async () => {
    if (!signer.isReady) return;
    setBusy(true);
    const tid = addToast("loading", "Authenticating with Imperial…");
    try {
      const token = await imperial.ensureAuth(signer);
      setJwt(token);
      await refreshBalances(token);
      updateToast(tid, { type: "success", title: "Authenticated", detail: "JWT acquired (30-day)." });
    } catch (e) {
      updateToast(tid, { type: "error", title: "Auth failed", detail: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [signer, addToast, updateToast, setJwt, refreshBalances]);

  const handleDeposit = useCallback(async () => {
    const amt = Number(depositAmt);
    if (!wallet || !(amt > 0)) return;
    setBusy(true);
    const tid = addToast("loading", `Depositing $${amt} to profile ${profileIndex}…`);
    try {
      const token = await ensureJwt();
      const { transaction } = await imperial.buildDepositTx({
        wallet,
        profileIndex,
        amount: Math.round(amt * 1e6),
        mode: "deposit",
      });
      const { signature } = await signer.signAndSendTransaction({ kind: "solana-versioned", base64: transaction });
      updateToast(tid, { type: "success", title: "Deposit submitted", detail: `$${amt} → profile ${profileIndex}`, txid: signature });
      setDepositAmt("");
      // Balances settle a few seconds after confirmation.
      setTimeout(() => void refreshBalances(token), 4000);
    } catch (e) {
      updateToast(tid, { type: "error", title: "Deposit failed", detail: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [depositAmt, wallet, profileIndex, ensureJwt, signer, addToast, updateToast, refreshBalances]);

  const submit = useCallback(
    async (side: "long" | "short") => {
      if (!wallet || busy) return;
      const input: OrderFormInput = {
        wallet,
        profileIndex,
        symbol,
        venue,
        side,
        type,
        sizeUsd: sizeNum,
        collateralUsd: collateralNum,
        markPrice: mark ?? 0,
        limitPrice: Number(limitPrice) || undefined,
        slippageBps,
      };
      const err = validateOrder(input);
      if (err) {
        addToast("error", "Can't place order", err);
        return;
      }
      setBusy(true);
      const verb = type === "limit" ? "Limit" : "Market";
      const tid = addToast("loading", `${verb} ${side} ${symbol}…`, `$${sizeNum} @ ${lev.toFixed(1)}x`);
      try {
        const token = await ensureJwt();
        const res = await imperial.placeOrder(buildOrderRequest(input), token);
        if (!res.success) throw new Error(res.error ?? "Order rejected");
        updateToast(tid, {
          type: "success",
          title: `${verb} ${side} placed`,
          detail: res.orderPda ? `orderPda ${res.orderPda.slice(0, 10)}…` : undefined,
          txid: res.signature ?? undefined,
        });
        bumpRefresh();
        void refreshBalances(token);
      } catch (e) {
        updateToast(tid, { type: "error", title: "Order failed", detail: errMsg(e) });
      } finally {
        setBusy(false);
      }
    },
    [wallet, busy, profileIndex, symbol, venue, type, sizeNum, collateralNum, mark, limitPrice, slippageBps, lev, ensureJwt, addToast, updateToast, bumpRefresh, refreshBalances]
  );

  const notConnected = !signer.isReady;
  const needsAuth = signer.isReady && !jwt;

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {/* Venue + leverage badge */}
      <div className="flex items-center justify-between">
        <select
          value={venue}
          onChange={(e) => setVenue(e.target.value as VenueTag)}
          className="border border-metric-border bg-metric-bg px-2 py-1 font-mono text-[11px] text-text-primary outline-none"
        >
          {VENUES.map((v) => (
            <option key={v.tag} value={v.tag}>
              {v.label}
            </option>
          ))}
        </select>
        <span className="font-mono text-[11px] text-text-secondary">
          {lev > 0 ? `${lev.toFixed(1)}x` : "—"} · Isolated
        </span>
      </div>

      {/* Market / Limit tabs */}
      <div className="flex border border-metric-border">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={clsx(
              "flex-1 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
              type === t ? "bg-surface-2 text-metric-primary" : "text-text-secondary/60 hover:text-text-secondary"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Profile selector */}
      <Field label="Profile (isolated 0–5)">
        <div className="flex gap-1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <button
              key={i}
              onClick={() => setProfileIndex(i)}
              className={clsx(
                "flex-1 border py-1 font-mono text-[11px] transition-colors",
                profileIndex === i
                  ? "border-metric-primary/60 bg-surface-2 text-metric-primary"
                  : "border-metric-border text-text-secondary/70 hover:text-text-secondary"
              )}
            >
              {i}
            </button>
          ))}
        </div>
      </Field>

      {type === "limit" && (
        <Field label="Limit Price (USD)">
          <input className={inputCls} inputMode="decimal" placeholder={mark ? formatPriceAuto(mark) : "0.00"} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
        </Field>
      )}

      <Field
        label="Collateral (USDC)"
        right={<span className="font-mono text-[10px] text-text-secondary/60">bal: ${profileBalance.toFixed(2)}</span>}
      >
        <input className={inputCls} inputMode="decimal" placeholder={`min $${MIN_COLLATERAL_USD}`} value={collateral} onChange={(e) => setCollateral(e.target.value)} />
      </Field>

      <Field label="Size (USD notional)">
        <input className={inputCls} inputMode="decimal" placeholder="0.00" value={size} onChange={(e) => setSize(e.target.value)} />
      </Field>

      {/* Leverage presets — set size from collateral × leverage */}
      <div className="flex gap-1">
        {LEVERAGE_PRESETS.map((x) => (
          <button
            key={x}
            onClick={() => collateralNum > 0 && setSize(String(+(collateralNum * x).toFixed(2)))}
            className="flex-1 border border-metric-border py-1 font-mono text-[10px] text-text-secondary/70 transition-colors hover:border-metric-primary/40 hover:text-metric-primary"
          >
            {x}x
          </button>
        ))}
      </div>

      <Field label="Slippage (bps)">
        <input
          className={inputCls}
          inputMode="numeric"
          value={slippageBps}
          onChange={(e) => setSlippageBps(Math.max(0, Math.min(10000, Number(e.target.value) || 0)))}
        />
      </Field>

      {/* Estimates */}
      <div className="space-y-1 border-t border-metric-border/50 pt-2 font-mono text-[10px] text-text-secondary">
        <Row label="Mark" value={mark != null ? `$${formatPriceAuto(mark)}` : "—"} />
        <Row label="Est. Entry" value={type === "limit" && limitPrice ? `$${limitPrice}` : mark != null ? `$${formatPriceAuto(mark)}` : "—"} />
        <Row label="Leverage" value={lev > 0 ? `${lev.toFixed(2)}x` : "—"} />
      </div>

      {/* Action */}
      <div className="mt-auto space-y-2">
        {notConnected ? (
          <div className="border border-metric-border bg-surface-2 px-3 py-2 text-center font-mono text-[11px] text-text-secondary">
            Connect a wallet to trade
          </div>
        ) : needsAuth ? (
          <button
            onClick={handleAuth}
            disabled={busy}
            className="w-full border border-metric-primary/60 bg-metric-primary/10 py-2 font-mono text-[12px] uppercase tracking-wider text-metric-primary transition-colors hover:bg-metric-primary/20 disabled:opacity-50"
          >
            {busy ? "Authenticating…" : "Authenticate with Imperial"}
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => submit("long")}
              disabled={busy}
              className="bg-metric-buy py-2.5 font-mono text-[13px] font-semibold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Long
            </button>
            <button
              onClick={() => submit("short")}
              disabled={busy}
              className="bg-metric-sell py-2.5 font-mono text-[13px] font-semibold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Short
            </button>
          </div>
        )}

        {/* Deposit affordance */}
        {signer.isReady && (
          <div className="flex gap-1">
            <input
              className="min-w-0 flex-1 border border-metric-border bg-metric-bg px-2 py-1 font-mono text-[11px] text-text-primary outline-none focus:border-metric-primary/60"
              inputMode="decimal"
              placeholder="USDC"
              value={depositAmt}
              onChange={(e) => setDepositAmt(e.target.value)}
            />
            <button
              onClick={handleDeposit}
              disabled={busy || !(Number(depositAmt) > 0)}
              className="border border-metric-border px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-secondary transition-colors hover:border-metric-primary/40 hover:text-metric-primary disabled:opacity-40"
            >
              Deposit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-secondary/60">{label}</span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof ImperialError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
