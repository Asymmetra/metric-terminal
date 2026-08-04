"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useSigner } from "@/lib/wallet";
import { imperial } from "@/lib/imperial";
import { ImperialError } from "@/lib/imperial/client";
import { loadJwt } from "@/lib/imperial/jwt";
import type { ApiTouchPosition, TouchDealRow, TouchMarketRow } from "@/lib/imperial/types";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { useToastStore } from "@/stores/toastStore";
import { useVisibilityInterval } from "@/hooks/useVisibilityInterval";
import { marketData } from "@/lib/market-data";
import { LiveLineChart } from "@/components/terminal/LiveLineChart";
import { PointsChip } from "@/components/terminal/PointsChip";
import { Toasts } from "@/components/shared/Toasts";
import { formatPriceAuto } from "@/lib/format";
import { confirmSignatureHttp, fetchWalletUsdc } from "@/lib/solana-rpc";
import { PRICE_SCALE, USD_SCALE } from "@/lib/order-builder";
import { TradeFlowError } from "@/lib/trade-flow";
import {
  TOUCH_PROFILE,
  claimTouch,
  openTouchWithDeposit,
  sellBackTouch,
  type TouchProgress,
} from "@/lib/touch-flow";
import { touchPremiumBudget } from "@/lib/touch-order";

/**
 * Imperial Touch — one-touch barrier / no-touch binary options (underwriter 6).
 *
 * You pick an underlying (SOL / BTC), a barrier, and a direction (Touch pays if
 * spot reaches the barrier before expiry; No-Touch pays if it never does). You
 * choose your PAYOUT; the market quotes the PREMIUM (payout × ask). One tap
 * deposits the premium (if the profile is underfunded) and buys — a single
 * signature. Proceeds settle automatically at the cohort expiry (or the instant a
 * Touch barrier is swept) into the profile's free USDC, which you then claim home.
 *
 * v1 trades the 24h tenor via the bare touch symbol ("SOLTOUCH"/"BTCTOUCH"), which
 * Imperial resolves to the lowest marketId = 24h. 1h/5m tenors need the market PDA
 * (not exposed by the API), so they are shown as "coming soon" and not tradeable.
 *
 * All money-path logic lives in touch-flow.ts / touch-order.ts (verified contract,
 * unit-tested). This file is UI + polling only — it never re-derives the wire
 * mapping. Uses a dedicated profile (TOUCH_PROFILE = 4) so touch USDC never
 * commingles with perp margin.
 */

/** The two supported underlyings. Chart symbol is the underlying; touch symbol is the family. */
const UNDERLYINGS = [
  { underlying: "SOL", touchSymbol: "SOLTOUCH", label: "SOL" },
  { underlying: "BTC", touchSymbol: "BTCTOUCH", label: "BTC" },
] as const;
type Underlying = (typeof UNDERLYINGS)[number]["underlying"];

const TENOR_24H_SECS = 86_400; // v1 tenor — the only one addressable via the bare symbol
const POSITIONS_POLL_MS = 3_000; // /touch/positions is not on /ws — poll (~3s per the contract)
const DEALS_POLL_MS = 30_000; // /touch/deals is cached ~60s server-side; a 30s refresh keeps asks reasonably fresh
const MARKETS_POLL_MS = 30_000; // /touch/markets refresh cadence (halted/config/spot can change)

function errMsg(e: unknown): string {
  if (e instanceof ImperialError || e instanceof Error) return e.message;
  return String(e);
}

/** 1e9 oracle-scale price → display dollars. */
function priceFromOracle(p: number): number {
  return p / PRICE_SCALE;
}
/** µUSD → display dollars. */
function usdFromMicros(u: number): number {
  return u / USD_SCALE;
}

/** Seconds remaining until a unix-second expiry (never negative). */
function secsUntil(expiryTs: number, nowMs: number): number {
  return Math.max(0, expiryTs - Math.floor(nowMs / 1000));
}

/** h:mm:ss / m:ss countdown from a seconds value. */
function formatCountdown(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function TouchUI() {
  const signer = useSigner();
  const wallet = signer.publicKey;
  const { connection } = useConnection();

  const jwt = useTraderStore((s) => s.jwt);
  const setJwt = useTraderStore((s) => s.setJwt);
  const addToast = useToastStore((s) => s.addToast);
  const updateToast = useToastStore((s) => s.updateToast);

  const [underlying, setUnderlying] = useState<Underlying>("SOL");
  const touchSymbol = UNDERLYINGS.find((u) => u.underlying === underlying)!.touchSymbol;

  const mark = useStatsStore((s) => s.marks[underlying]);

  const [markets, setMarkets] = useState<TouchMarketRow[]>([]);
  const [deals, setDeals] = useState<TouchDealRow[]>([]);
  const [positions, setPositions] = useState<ApiTouchPosition[]>([]);
  const [isTouch, setIsTouch] = useState(true); // Touch (true) vs No-Touch (false)
  const [selectedBarrier, setSelectedBarrier] = useState<number | null>(null); // barrier1e9 of the chosen deal
  const [payout, setPayout] = useState("10"); // display dollars
  const [busy, setBusy] = useState(false);
  const [walletUsdc, setWalletUsdc] = useState<number | null>(null);
  const [profileFreeUsd, setProfileFreeUsd] = useState<number | null>(null); // claimable USDC in the touch profile
  const [nowMs, setNowMs] = useState(() => Date.now());

  // ── the tradeable 24h market for the selected underlying ──
  // Each tenor is a separate market row; the 24h tenor is the only one addressable
  // via the bare symbol (its market PDA is the one Imperial resolves the symbol to).
  const market = useMemo(
    () =>
      markets.find(
        (m) => m.symbol === touchSymbol && m.config.cohortWindowSecs === TENOR_24H_SECS
      ) ?? null,
    [markets, touchSymbol]
  );
  const marketId = market?.marketId;
  const halted = market?.halted ?? false;

  // Deals for the tradeable 24h market, split by side.
  const sideDeals = useMemo(() => {
    if (marketId === undefined) return [] as TouchDealRow[];
    return deals
      .filter((d) => d.marketId === marketId && d.isTouch === isTouch)
      .sort((a, b) => a.barrier1e9 - b.barrier1e9);
  }, [deals, marketId, isTouch]);

  const selectedDeal = useMemo(
    () => sideDeals.find((d) => d.barrier1e9 === selectedBarrier) ?? null,
    [sideDeals, selectedBarrier]
  );

  // Payout bounds (µUSD → display dollars) from the market config.
  const minPayout = market ? usdFromMicros(market.config.minPayoutUsd) : 1;
  const maxPayout = market ? usdFromMicros(market.config.maxPayoutUsd) : 1000;
  const payoutNum = Number(payout) || 0;
  const payoutMicros = Math.round(payoutNum * USD_SCALE);

  // Bounds-check the WIRE value (payoutMicros — the µUSD integer actually sent as
  // sizeUsd) against the config µUSD floor/ceiling directly, not a display-dollar
  // round-trip, so a value that reads in-range but rounds out of bounds is rejected.
  const payoutErr = useMemo(() => {
    if (!market) return "Waiting for market…";
    if (!(payoutMicros > 0)) return "Enter a payout.";
    if (payoutMicros < market.config.minPayoutUsd) return `Min payout is $${formatPriceAuto(minPayout)}.`;
    if (payoutMicros > market.config.maxPayoutUsd) return `Max payout is $${formatPriceAuto(maxPayout)}.`;
    return null;
  }, [market, payoutMicros, minPayout, maxPayout]);

  // Live premium (payout × ask) + the budget (with 100bps slack) for the chosen deal.
  const premiumUsd = selectedDeal ? usdFromMicros((payoutMicros * selectedDeal.askBps) / 10000) : 0;
  const budgetMicros = selectedDeal ? touchPremiumBudget(payoutMicros, selectedDeal.askBps) : 0;
  const budgetUsd = usdFromMicros(budgetMicros);

  const canBuy =
    signer.isReady && !busy && !halted && !!selectedDeal && !payoutErr && marketId !== undefined;

  // ── live price feed for the underlying (shared ref-counted controller) ──
  useEffect(() => {
    marketData.start();
    return () => marketData.stop();
  }, []);
  useEffect(() => {
    marketData.setDepthSymbol(underlying);
  }, [underlying]);

  // ── 1s clock for the expiry countdowns ──
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Hydrate a cached JWT so returning users skip the auth signature.
  useEffect(() => {
    if (!wallet || jwt) return;
    const cached = loadJwt(wallet);
    if (cached) setJwt(cached);
  }, [wallet, jwt, setJwt]);

  const ensureJwt = useCallback(async (): Promise<string> => {
    if (jwt) return jwt;
    const token = await imperial.ensureAuth(signer);
    setJwt(token);
    return token;
  }, [jwt, signer, setJwt]);

  const confirm = useCallback(
    (sig: string) => confirmSignatureHttp(connection, sig),
    [connection]
  );

  const assertDepositReady = useCallback(
    async (depositNative: number) => {
      if (!wallet) throw new Error("Connect a wallet first.");
      // Instant, clear USDC check against the known wallet balance (µUSD → dollars)
      // before we ever touch the chain — the deposit debits this many USDC.
      if (walletUsdc != null && depositNative / 1e6 > walletUsdc) {
        throw new Error(
          `Need ~$${(depositNative / 1e6).toFixed(2)} USDC (have $${walletUsdc.toFixed(2)}).`
        );
      }
      const { PublicKey } = await import("@solana/web3.js");
      const lamports = await connection.getBalance(new PublicKey(wallet)).catch(() => null);
      if (lamports != null && lamports < 0.005 * 1e9) {
        throw new Error(`Need a little SOL for gas (have ${(lamports / 1e9).toFixed(4)}).`);
      }
    },
    [wallet, connection, walletUsdc]
  );

  // ── touch markets: refresh on mount + every 30s (halted/config/spot can change) ──
  const refreshMarkets = useCallback(() => {
    void imperial
      .getTouchMarkets()
      .then((rows) => setMarkets(rows))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshMarkets();
  }, [refreshMarkets]);
  useVisibilityInterval(refreshMarkets, MARKETS_POLL_MS, true);

  // ── touch deals for the selected 24h market: refresh on market change + every 30s ──
  const refreshDeals = useCallback(() => {
    if (marketId === undefined) {
      setDeals([]);
      return;
    }
    void imperial
      .getTouchDeals(marketId)
      .then((rows) => setDeals(rows))
      .catch(() => {});
  }, [marketId]);
  useEffect(() => {
    refreshDeals();
  }, [refreshDeals]);
  useVisibilityInterval(refreshDeals, DEALS_POLL_MS, marketId !== undefined);

  // Keep a valid barrier selected as the deal set changes.
  useEffect(() => {
    if (sideDeals.length === 0) {
      setSelectedBarrier(null);
      return;
    }
    if (selectedBarrier != null && sideDeals.some((d) => d.barrier1e9 === selectedBarrier)) return;
    // Default barrier: Touch → NEAREST spot (most likely to be reached); No-Touch →
    // FURTHEST from spot (lowest touch probability = cheapest ask, safest "never").
    const spot = market ? market.spotPrice1e9 : sideDeals[0].barrier1e9;
    const pick = sideDeals.reduce((best, d) => {
      const dDist = Math.abs(d.barrier1e9 - spot);
      const bDist = Math.abs(best.barrier1e9 - spot);
      return (isTouch ? dDist < bDist : dDist > bDist) ? d : best;
    });
    setSelectedBarrier(pick.barrier1e9);
  }, [sideDeals, selectedBarrier, market, isTouch]);

  // ── touch positions: poll every ~3s (not on /ws) ──
  const refreshPositions = useCallback(
    (isCancelled?: () => boolean) => {
      if (!wallet) {
        setPositions([]);
        return;
      }
      void imperial
        .getTouchPositions(wallet)
        .then((rows) => {
          if (!isCancelled?.()) setPositions(rows);
        })
        .catch(() => {});
    },
    [wallet]
  );
  useEffect(() => {
    let cancelled = false;
    refreshPositions(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refreshPositions]);
  useVisibilityInterval(() => refreshPositions(), POSITIONS_POLL_MS, !!wallet);

  // ── header balances: spendable wallet USDC + claimable profile USDC ──
  const refreshBalances = useCallback(
    (isCancelled?: () => boolean) => {
      if (!wallet) {
        setWalletUsdc(null);
        setProfileFreeUsd(null);
        return;
      }
      void fetchWalletUsdc(wallet).then((v) => {
        if (!isCancelled?.()) setWalletUsdc(v);
      });
      const token = jwt ?? loadJwt(wallet);
      if (token) {
        void imperial
          .getBalances(token)
          .then((b) => {
            if (isCancelled?.()) return;
            const free = b.profiles.find((p) => p.profileIndex === TOUCH_PROFILE)?.usdc ?? 0;
            setProfileFreeUsd(free / USD_SCALE);
          })
          .catch(() => {});
      }
    },
    [wallet, jwt]
  );
  useEffect(() => {
    let cancelled = false;
    refreshBalances(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refreshBalances]);
  useVisibilityInterval(() => refreshBalances(), 5_000, !!wallet);

  // ── one-tap BUY ──
  const buy = useCallback(async () => {
    if (!canBuy || !wallet || !selectedDeal || marketId === undefined) return;
    setBusy(true);
    const label = isTouch ? "Touch" : "No-Touch";
    const tid = addToast(
      "loading",
      `Buying ${label} ${underlying}…`,
      `$${formatPriceAuto(payoutNum)} payout · premium ~$${formatPriceAuto(premiumUsd)}`
    );
    try {
      const token = await ensureJwt();
      await openTouchWithDeposit(
        {
          wallet,
          profileIndex: TOUCH_PROFILE,
          symbol: touchSymbol, // v1: bare symbol → 24h tenor (no marketMint)
          isTouch,
          barrier1e9: selectedDeal.barrier1e9,
          payoutUsd: payoutMicros,
          premiumBudgetUsd: budgetMicros,
        },
        {
          signer,
          jwt: token,
          confirm,
          assertDepositReady,
          onStep: (p: TouchProgress) =>
            updateToast(tid, { type: "loading", title: `Buying ${label}…`, detail: p.message }),
        }
      );
      updateToast(tid, {
        type: "success",
        title: "Position opened",
        detail: `${label} ${underlying} · $${formatPriceAuto(payoutNum)} payout`,
      });
      refreshPositions();
      refreshBalances();
    } catch (e) {
      // TradeFlowError = funds are safe in the profile (deposit landed but buy bounced,
      // or the buy was rejected). Anything else is a hard failure.
      const safe = e instanceof TradeFlowError;
      updateToast(tid, {
        type: safe ? "info" : "error",
        title: safe ? "Didn't buy — funds safe" : "Buy failed",
        detail: errMsg(e),
      });
      refreshPositions();
      refreshBalances();
    } finally {
      setBusy(false);
    }
  }, [
    canBuy,
    wallet,
    selectedDeal,
    marketId,
    isTouch,
    underlying,
    touchSymbol,
    payoutNum,
    payoutMicros,
    premiumUsd,
    budgetMicros,
    signer,
    ensureJwt,
    confirm,
    assertDepositReady,
    addToast,
    updateToast,
    refreshPositions,
    refreshBalances,
  ]);

  // ── sell back (early close) ──
  const sellBack = useCallback(
    async (pos: ApiTouchPosition) => {
      if (!wallet || busy) return;
      setBusy(true);
      const tid = addToast("loading", "Selling back…", "no signature needed");
      try {
        const token = await ensureJwt();
        await sellBackTouch(
          {
            wallet,
            profileIndex: TOUCH_PROFILE,
            symbol: pos.symbol,
            positionId: pos.positionId,
            payoutUsd: pos.payoutUsd, // echo byte-for-byte (a re-derived value is refused)
            minRefundUsd: 0, // accept any bid
          },
          {
            signer,
            jwt: token,
            onStep: (p: TouchProgress) =>
              updateToast(tid, { type: "loading", title: "Selling back…", detail: p.message }),
          }
        );
        updateToast(tid, {
          type: "success",
          title: "Sold back",
          detail: "Proceeds settling into your touch profile — claim when ready.",
        });
        refreshPositions();
        refreshBalances();
      } catch (e) {
        // TradeFlowError carries the humanized terminal message (barrier swept /
        // settles-at-expiry / already closed) — surface it as info, not a hard error.
        const soft = e instanceof TradeFlowError;
        updateToast(tid, {
          type: soft ? "info" : "error",
          title: "Couldn't sell back",
          detail: errMsg(e),
        });
        refreshPositions();
      } finally {
        setBusy(false);
      }
    },
    [wallet, busy, signer, ensureJwt, addToast, updateToast, refreshPositions, refreshBalances]
  );

  // ── claim (withdraw settled proceeds to the wallet) ──
  const claim = useCallback(async () => {
    if (!wallet || busy) return;
    setBusy(true);
    const tid = addToast("loading", "Claiming to wallet…");
    try {
      const token = await ensureJwt();
      const res = await claimTouch(
        { wallet, profileIndex: TOUCH_PROFILE },
        {
          signer,
          jwt: token,
          confirm,
          onStep: (p: TouchProgress) =>
            updateToast(tid, { type: "loading", title: "Claiming…", detail: p.message }),
        }
      );
      if (res.withdrawnNative > 0) {
        updateToast(tid, {
          type: "success",
          title: "Claimed to wallet",
          detail: `$${formatPriceAuto(res.withdrawnNative / USD_SCALE)} → wallet`,
          txid: res.signature,
        });
      } else {
        updateToast(tid, {
          type: "info",
          title: "Nothing to claim",
          detail: "No free balance in the touch profile.",
        });
      }
      refreshBalances();
    } catch (e) {
      updateToast(tid, { type: "error", title: "Claim failed", detail: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [wallet, busy, signer, ensureJwt, confirm, addToast, updateToast, refreshBalances]);

  // Barrier reference line for the chart (drawn via the entryLines mechanism).
  const entryLines = useMemo(() => {
    if (selectedBarrier == null) return undefined;
    return [{ value: priceFromOracle(selectedBarrier), label: "Barrier" }];
  }, [selectedBarrier]);

  const openPositions = positions.filter((p) => p.status === "open");
  const finishedPositions = positions.filter((p) => p.status !== "open");
  const hasClaimable = (profileFreeUsd ?? 0) > 0.000001;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* top bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-metric-border bg-surface-1 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-bold tracking-wide text-text-primary">
            IMPERIAL TOUCH
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">
            barrier options · 24h tenor
          </span>
        </div>
        <div className="flex items-center gap-3">
          <PointsChip wallet={wallet} />
          {signer.isReady && (
            <>
              {hasClaimable && (
                <button
                  onClick={claim}
                  disabled={busy}
                  className="bg-metric-buy px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                  title="Withdraw settled touch proceeds to your wallet"
                >
                  Claim ${formatPriceAuto(profileFreeUsd ?? 0)}
                </button>
              )}
              <span className="font-mono text-[12px] text-text-secondary" title="Spendable wallet USDC">
                {walletUsdc != null ? `$${walletUsdc.toFixed(2)} USDC` : "—"}
              </span>
            </>
          )}
          <WalletMultiButton />
        </div>
      </div>

      {/* underlying + tenor selector */}
      <div className="flex shrink-0 items-center gap-4 border-b border-metric-border bg-surface-1 px-4 py-2">
        <div className="flex">
          {UNDERLYINGS.map((u) => (
            <button
              key={u.underlying}
              onClick={() => setUnderlying(u.underlying)}
              className={clsx(
                "border px-4 py-1.5 font-mono text-[12px] font-bold uppercase tracking-wider transition-colors first:border-r-0",
                underlying === u.underlying
                  ? "border-metric-primary bg-metric-primary text-metric-bg"
                  : "border-metric-border text-text-secondary hover:text-text-primary"
              )}
            >
              {u.label}
            </button>
          ))}
        </div>
        <TenorTabs />
        {mark != null && (
          <span className="ml-auto font-mono text-[12px] text-text-secondary">
            {underlying} spot <span className="text-text-primary">${formatPriceAuto(mark)}</span>
          </span>
        )}
        {halted && (
          <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-metric-sell">
            Market halted — read only
          </span>
        )}
      </div>

      {/* main: chart + control column */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* chart with the selected barrier reference line */}
        <div className="relative min-h-0 flex-1 overflow-hidden border-r border-metric-border">
          <LiveLineChart
            symbol={underlying}
            entryLines={entryLines}
            seedPrice={market ? priceFromOracle(market.spotPrice1e9) : undefined}
          />
        </div>

        {/* control column */}
        <div className="flex w-[380px] shrink-0 flex-col overflow-y-auto bg-surface-1">
          {/* Touch / No-Touch toggle */}
          <div className="border-b border-metric-border px-4 py-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">
              Direction
            </div>
            <div className="flex">
              <button
                onClick={() => setIsTouch(true)}
                className={clsx(
                  "flex-1 border px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-wider transition-colors",
                  isTouch
                    ? "border-metric-buy bg-metric-buy text-metric-bg"
                    : "border-metric-border text-text-secondary hover:text-text-primary"
                )}
              >
                Touch
              </button>
              <button
                onClick={() => setIsTouch(false)}
                className={clsx(
                  "flex-1 border border-l-0 px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-wider transition-colors",
                  !isTouch
                    ? "border-metric-sell bg-metric-sell text-metric-bg"
                    : "border-metric-border text-text-secondary hover:text-text-primary"
                )}
              >
                No-Touch
              </button>
            </div>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-text-secondary/60">
              {isTouch
                ? "Pays the payout if spot REACHES the barrier before expiry."
                : "Pays the payout if spot NEVER reaches the barrier before expiry."}
            </p>
          </div>

          {/* Payout input */}
          <div className="border-b border-metric-border px-4 py-3">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">
              Payout (USDC)
              {market && (
                <span className="ml-1 text-text-secondary/40">
                  · ${formatPriceAuto(minPayout)}–${formatPriceAuto(maxPayout)}
                </span>
              )}
            </div>
            <div className="flex items-center border border-metric-border bg-metric-bg px-2">
              <span className="font-mono text-sm text-text-secondary/60">$</span>
              <input
                inputMode="decimal"
                value={payout}
                onChange={(e) => setPayout(e.target.value)}
                className="w-full bg-transparent px-1 py-2 font-mono text-sm text-text-primary outline-none"
              />
            </div>
            {payoutErr && (
              <p className="mt-1 font-mono text-[10px] text-metric-sell">{payoutErr}</p>
            )}
          </div>

          {/* Deals grid (barriers) */}
          <div className="border-b border-metric-border px-4 py-3">
            <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">
              <span>Barrier</span>
              <span>Ask · Premium</span>
            </div>
            {sideDeals.length === 0 ? (
              <p className="py-4 text-center font-mono text-[11px] text-text-secondary/50">
                {marketId === undefined ? "Loading market…" : "No barriers quoted right now."}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {sideDeals.map((d) => {
                  const barrierUsd = priceFromOracle(d.barrier1e9);
                  const dealPremium = usdFromMicros((payoutMicros * d.askBps) / 10000);
                  const selected = d.barrier1e9 === selectedBarrier;
                  return (
                    <button
                      key={`${d.barrier1e9}-${d.isTouch}`}
                      onClick={() => setSelectedBarrier(d.barrier1e9)}
                      className={clsx(
                        "flex items-center justify-between border px-3 py-2 font-mono text-[12px] transition-colors",
                        selected
                          ? "border-metric-primary bg-metric-primary/10 text-text-primary"
                          : "border-metric-border text-text-secondary hover:text-text-primary"
                      )}
                    >
                      <span className="tabular-nums">${formatPriceAuto(barrierUsd)}</span>
                      <span className="tabular-nums text-text-secondary/70">
                        {d.askBps}bps ·{" "}
                        <span className="text-text-primary">${formatPriceAuto(dealPremium)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Live premium / budget + BUY */}
          <div className="px-4 py-3">
            {selectedDeal && (
              <div className="mb-3 space-y-1 font-mono text-[11px]">
                <div className="flex justify-between text-text-secondary">
                  <span>Premium (payout × ask)</span>
                  <span className="tabular-nums text-text-primary">
                    ${formatPriceAuto(premiumUsd)}
                  </span>
                </div>
                <div className="flex justify-between text-text-secondary">
                  <span title="Max you'll pay — the fill debits the live ask and refunds the rest (100bps slack)">
                    Budget (max, +100bps slack)
                  </span>
                  <span className="tabular-nums text-text-secondary/80">
                    ${formatPriceAuto(budgetUsd)}
                  </span>
                </div>
              </div>
            )}
            {!signer.isReady ? (
              <WalletMultiButton />
            ) : (
              <button
                onClick={buy}
                disabled={!canBuy}
                title={halted ? "Market halted" : payoutErr ?? undefined}
                className={clsx(
                  "w-full py-3 font-mono text-[14px] font-bold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50",
                  isTouch ? "bg-metric-buy" : "bg-metric-sell"
                )}
              >
                {busy
                  ? "Working…"
                  : `Buy ${isTouch ? "Touch" : "No-Touch"} — $${formatPriceAuto(premiumUsd)}`}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* positions panel */}
      <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-metric-border bg-surface-1">
        <PositionsPanel
          open={openPositions}
          finished={finishedPositions}
          nowMs={nowMs}
          busy={busy}
          onSellBack={sellBack}
          connected={signer.isReady}
        />
      </div>

      <Toasts />
    </div>
  );
}

/** Static tenor tabs — only 24h is live in v1; 1h/5m need the market PDA from Imperial. */
function TenorTabs() {
  return (
    <div className="flex items-center gap-1">
      <span className="border border-metric-primary bg-metric-primary/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-metric-primary">
        24h
      </span>
      <span
        className="cursor-not-allowed border border-metric-border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-text-secondary/40"
        title="1h tenor coming soon — needs the market PDA from Imperial"
      >
        1h
      </span>
      <span
        className="cursor-not-allowed border border-metric-border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-text-secondary/40"
        title="5m tenor coming soon — needs the market PDA from Imperial"
      >
        5m
      </span>
      <span className="ml-1 font-mono text-[9px] uppercase tracking-wider text-text-secondary/30">
        1h/5m soon
      </span>
    </div>
  );
}

function PositionsPanel({
  open,
  finished,
  nowMs,
  busy,
  onSellBack,
  connected,
}: {
  open: ApiTouchPosition[];
  finished: ApiTouchPosition[];
  nowMs: number;
  busy: boolean;
  onSellBack: (p: ApiTouchPosition) => void;
  connected: boolean;
}) {
  if (!connected) {
    return (
      <div className="py-6 text-center font-mono text-[12px] text-text-secondary/50">
        Connect a wallet to see your touch positions.
      </div>
    );
  }
  if (open.length === 0 && finished.length === 0) {
    return (
      <div className="py-6 text-center font-mono text-[12px] text-text-secondary/50">
        No touch positions yet.
      </div>
    );
  }
  return (
    <table className="w-full font-mono text-[11px]">
      <thead className="sticky top-0 bg-surface-1">
        <tr className="border-b border-metric-border text-left text-[10px] uppercase tracking-wider text-text-secondary/60">
          <th className="px-3 py-2 font-normal">Market</th>
          <th className="px-3 py-2 font-normal">Dir</th>
          <th className="px-3 py-2 text-right font-normal">Barrier</th>
          <th className="px-3 py-2 text-right font-normal">Payout</th>
          <th className="px-3 py-2 text-right font-normal">Premium</th>
          <th className="px-3 py-2 text-right font-normal">Expiry</th>
          <th className="px-3 py-2 text-right font-normal">Status</th>
          <th className="px-3 py-2 text-right font-normal"></th>
        </tr>
      </thead>
      <tbody>
        {open.map((p) => (
          <PositionRow
            key={p.positionId}
            p={p}
            nowMs={nowMs}
            busy={busy}
            onSellBack={onSellBack}
          />
        ))}
        {finished.map((p) => (
          <PositionRow key={p.positionId} p={p} nowMs={nowMs} busy={busy} onSellBack={onSellBack} />
        ))}
      </tbody>
    </table>
  );
}

function PositionRow({
  p,
  nowMs,
  busy,
  onSellBack,
}: {
  p: ApiTouchPosition;
  nowMs: number;
  busy: boolean;
  onSellBack: (p: ApiTouchPosition) => void;
}) {
  const barrierUsd = priceFromOracle(p.barrier1e9);
  const payoutUsd = usdFromMicros(p.payoutUsd);
  const premiumUsd = usdFromMicros(p.premiumUsd);
  const remainingSecs = secsUntil(p.expiryTs, nowMs);
  const isOpen = p.status === "open";
  const expired = remainingSecs <= 0;

  let statusEl: React.ReactNode;
  if (p.status === "open") {
    statusEl = <span className="text-metric-primary">OPEN</span>;
  } else {
    // settled | bought_back — show won/lost + paid
    const paid = p.payoutPaidUsd != null ? usdFromMicros(p.payoutPaidUsd) : null;
    if (p.status === "bought_back") {
      statusEl = (
        <span className="text-text-secondary">
          SOLD{paid != null ? ` · $${formatPriceAuto(paid)}` : ""}
        </span>
      );
    } else if (p.won) {
      statusEl = (
        <span className="text-metric-buy">
          WON{paid != null ? ` · $${formatPriceAuto(paid)}` : ""}
        </span>
      );
    } else {
      statusEl = <span className="text-metric-sell">LOST</span>;
    }
  }

  return (
    <tr className="border-b border-metric-border/50">
      <td className="px-3 py-2 text-text-primary">{p.symbol.replace("TOUCH", "")}</td>
      <td className="px-3 py-2">
        <span className={p.isTouch ? "text-metric-buy" : "text-metric-sell"}>
          {p.isTouch ? "Touch" : "No-Touch"}
        </span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
        ${formatPriceAuto(barrierUsd)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        ${formatPriceAuto(payoutUsd)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
        ${formatPriceAuto(premiumUsd)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
        {isOpen ? (expired ? "settling…" : formatCountdown(remainingSecs)) : "—"}
      </td>
      <td className="px-3 py-2 text-right">{statusEl}</td>
      <td className="px-3 py-2 text-right">
        {isOpen && !expired && (
          <button
            onClick={() => onSellBack(p)}
            disabled={busy}
            className="border border-metric-border px-2 py-1 text-[10px] uppercase tracking-wider text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            title="Early close — sell this position back for its current bid"
          >
            Sell back
          </button>
        )}
      </td>
    </tr>
  );
}
