"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useConnection } from "@solana/wallet-adapter-react";
import { useSigner } from "@/lib/wallet";
import { imperial } from "@/lib/imperial";
import { ImperialError } from "@/lib/imperial/client";
import { loadJwt } from "@/lib/imperial/jwt";
import type { VenueTag } from "@/lib/imperial/types";
import { useMarketStore } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { useToastStore } from "@/stores/toastStore";
import {
  impliedLeverage,
  validateOrder,
  MIN_COLLATERAL_USD,
  type OrderFormInput,
} from "@/lib/order-builder";
import { openWithDeposit, marketVenueCandidates, TradeFlowError } from "@/lib/trade-flow";
import { formatPriceAuto } from "@/lib/format";

// "auto" lets Imperial's /route pick the cheapest venue that supports the order
// (e.g. SOL market orders route to GMTrade; Phoenix is CLOB/limit-only via this
// path). Users can still force a specific venue.
type VenueChoice = VenueTag | "auto";
const VENUES: { tag: VenueChoice; label: string }[] = [
  { tag: "auto", label: "Auto (best route)" },
  { tag: "phoenix", label: "Phoenix" },
  { tag: "jupiter", label: "Jupiter" },
  { tag: "flash_trade", label: "Flash" },
  { tag: "gmtrade", label: "GMTrade" },
];
const MAX_LEVERAGE = 20;

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
  const { connection } = useConnection();

  const symbol = useMarketStore((s) => s.selectedSymbol);
  const mark = useStatsStore((s) => s.marks[symbol]);

  const jwt = useTraderStore((s) => s.jwt);
  const setJwt = useTraderStore((s) => s.setJwt);
  const balances = useTraderStore((s) => s.balances);
  const setBalances = useTraderStore((s) => s.setBalances);
  const bumpRefresh = useTraderStore((s) => s.bumpRefresh);

  const addToast = useToastStore((s) => s.addToast);
  const updateToast = useToastStore((s) => s.updateToast);

  const [venue, setVenue] = useState<VenueChoice>("auto");
  const [type, setType] = useState<"market" | "limit">("market");
  const [profileIndex, setProfileIndex] = useState(0);
  const [collateral, setCollateral] = useState("");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [busy, setBusy] = useState(false);

  const profileBalance = useMemo(() => {
    const p = balances.find((b) => b.profileIndex === profileIndex);
    return p ? p.usdc / 1e6 : 0;
  }, [balances, profileIndex]);

  const collateralNum = Number(collateral) || 0;
  const sizeNum = Number(size) || 0;
  const lev = impliedLeverage(sizeNum, collateralNum);

  // How much (if any) we'd auto-deposit to fund this order's collateral —
  // exactly the shortfall to the entered collateral (no buffer; venue fees are
  // netted into the position, not taken from the profile's free balance).
  const depositNeeded = useMemo(() => {
    if (!(collateralNum > 0)) return 0;
    return Math.max(0, +(collateralNum - profileBalance).toFixed(2));
  }, [collateralNum, profileBalance]);

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

  // Returning wallets: hydrate the cached 30-day JWT from localStorage so a valid
  // session skips the "Authenticate" prompt (no re-sign). loadJwt enforces expiry,
  // so an expired token falls back to the auth button.
  useEffect(() => {
    if (!wallet || jwt) return;
    const cached = loadJwt(wallet);
    if (cached) {
      setJwt(cached);
      void refreshBalances(cached);
    }
  }, [wallet, jwt, setJwt, refreshBalances]);

  // Gas / wallet-USDC preflight before signing a deposit. The operator sponsors
  // rent + ATA creation, but the wallet still pays the base tx fee, so it needs
  // a little SOL; and the deposit pulls from the wallet's USDC ATA.
  const assertDepositReady = useCallback(
    async (depositNative: number) => {
      if (!wallet) throw new Error("Connect a wallet first.");
      const pk = signer.publicKey;
      if (!pk) throw new Error("Connect a wallet first.");
      const { PublicKey } = await import("@solana/web3.js");
      const owner = new PublicKey(pk);
      const lamports = await connection.getBalance(owner).catch(() => null);
      if (lamports != null && lamports < 0.005 * 1e9) {
        throw new Error(`Need a little SOL for gas (have ${(lamports / 1e9).toFixed(4)}).`);
      }
      // Best-effort USDC check; if it fails we let the tx surface the error.
      try {
        const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const accs = await connection.getParsedTokenAccountsByOwner(owner, { mint: USDC });
        const have = accs.value.reduce(
          (a, x) => a + Number(x.account.data.parsed?.info?.tokenAmount?.amount ?? 0),
          0
        );
        if (have < depositNative) {
          throw new Error(
            `Insufficient wallet USDC: need $${(depositNative / 1e6).toFixed(2)}, have $${(have / 1e6).toFixed(2)}.`
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Insufficient wallet USDC")) throw e;
        /* RPC couldn't read token accounts — let the deposit tx fail loudly instead */
      }
    },
    [wallet, signer, connection]
  );

  const submit = useCallback(
    async (side: "long" | "short") => {
      if (!wallet || busy) return;
      // Resolve which venue(s) to attempt. We honor Imperial /route's pick (incl.
      // Phoenix — its market orders fill once marketPrice is sent at the right
      // venue scale, see toMarketPrice) and list the other candidates after it in
      // cost order; openWithDeposit tries them in turn, falling through only if the
      // router's choice genuinely rejects.
      let route: Awaited<ReturnType<typeof imperial.getRoute>> | null = null;
      try {
        route = await imperial.getRoute({
          asset: symbol,
          side,
          notional: sizeNum,
          desiredLeverage: Math.max(1, lev),
          wallet,
          profileIndex,
        });
      } catch {
        /* route unavailable — marketVenueCandidates falls back */
      }
      const venues = marketVenueCandidates({ type, selectedVenue: venue, route });
      if (type === "market" && venues.length === 0) {
        addToast("error", "Market order unavailable", `No venue is currently available to market-trade ${symbol}.`);
        return;
      }
      const input: OrderFormInput = {
        wallet,
        profileIndex,
        symbol,
        venue: venues[0] ?? "gmtrade",
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
        const { depositedNative, order, venue: filledVenue } = await openWithDeposit(input, {
          signer,
          jwt: token,
          venues,
          confirm: (sig) => connection.confirmTransaction(sig, "confirmed").then(() => undefined),
          assertDepositReady,
          onStep: (p) => updateToast(tid, { type: "loading", title: `${verb} ${side} ${symbol}`, detail: p.message }),
        });
        updateToast(tid, {
          type: "success",
          title: `${verb} ${side} ${symbol} opened on ${filledVenue}`,
          detail:
            (depositedNative > 0 ? `Deposited $${(depositedNative / 1e6).toFixed(2)} · ` : "") +
            (order.orderPda ? `orderPda ${order.orderPda.slice(0, 8)}…` : "filled"),
          txid: order.signature ?? undefined,
        });
        bumpRefresh();
        void refreshBalances(token);
      } catch (e) {
        const title = e instanceof TradeFlowError && e.depositedNative > 0 ? "Order failed (funds safe)" : "Order failed";
        updateToast(tid, { type: "error", title, detail: errMsg(e) });
        void ensureJwt().then((t) => refreshBalances(t)).catch(() => {});
      } finally {
        setBusy(false);
      }
    },
    [wallet, busy, profileIndex, symbol, venue, type, sizeNum, collateralNum, mark, limitPrice, slippageBps, lev, ensureJwt, signer, connection, assertDepositReady, addToast, updateToast, bumpRefresh, refreshBalances]
  );

  const notConnected = !signer.isReady;
  const needsAuth = signer.isReady && !jwt;

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {/* Venue + leverage badge */}
      <div className="flex items-center justify-between">
        <select
          value={venue}
          onChange={(e) => setVenue(e.target.value as VenueChoice)}
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

      {/* Leverage slider — drives size = collateral × leverage */}
      <Field
        label="Leverage"
        right={<span className="font-mono text-[11px] text-metric-primary">{(lev > 0 ? lev : 1).toFixed(1)}×</span>}
      >
        <input
          type="range"
          min={1}
          max={MAX_LEVERAGE}
          step={0.5}
          value={Math.min(MAX_LEVERAGE, Math.max(1, lev > 0 ? lev : 1))}
          onChange={(e) => collateralNum > 0 && setSize(String(+(collateralNum * Number(e.target.value)).toFixed(2)))}
          disabled={!(collateralNum > 0)}
          className="h-1 w-full cursor-pointer appearance-none rounded bg-metric-border accent-metric-primary disabled:cursor-not-allowed disabled:opacity-40"
        />
        <div className="mt-1 flex justify-between font-mono text-[9px] text-text-secondary/50">
          <span>1×</span>
          <span>{MAX_LEVERAGE}×</span>
        </div>
      </Field>

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
        {depositNeeded > 0 && (
          <Row label="Auto-deposit" value={`$${depositNeeded.toFixed(2)} (1 signature)`} />
        )}
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
              {depositNeeded > 0 ? "Deposit & Long" : "Long"}
            </button>
            <button
              onClick={() => submit("short")}
              disabled={busy}
              className="bg-metric-sell py-2.5 font-mono text-[13px] font-semibold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {depositNeeded > 0 ? "Deposit & Short" : "Short"}
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
