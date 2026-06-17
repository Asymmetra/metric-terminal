"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useSigner } from "@/lib/wallet";
import { imperial } from "@/lib/imperial";
import { ImperialError } from "@/lib/imperial/client";
import { loadJwt } from "@/lib/imperial/jwt";
import { useStatsStore } from "@/stores/statsStore";
import { useTraderStore } from "@/stores/traderStore";
import { useToastStore } from "@/stores/toastStore";
import { useVisibilityInterval } from "@/hooks/useVisibilityInterval";
import { marketData } from "@/lib/market-data";
import { LiveLineChart } from "@/components/terminal/LiveLineChart";
import { Toasts } from "@/components/shared/Toasts";
import { openWithDeposit, isTransientResolveError, TradeFlowError } from "@/lib/trade-flow";
import { buildCloseRequest, type OrderFormInput } from "@/lib/order-builder";
import { formatPriceAuto } from "@/lib/format";
import { confirmSignatureHttp, fetchWalletUsdc } from "@/lib/solana-rpc";
import {
  GAME_LEVERAGE,
  GAME_PROFILE,
  GAME_SYMBOL,
  GAME_VENUE,
  MIN_STAKE_USD,
  WINDOW_MS,
  type GameSide,
  sizeForStake,
  validateStake,
  initialDeadline,
  extendDeadline,
  remainingMs,
  formatCountdown,
  findGamePosition,
  num,
} from "./game-flow";

/**
 * Degen Mode — tap once to open a 400× SOL long on Flash V2, force-held for 60s with no
 * manual close. Double down to grow the bet and push the deadline +60s. At the deadline we
 * auto-close (delegated, no signature); the user then claims funds back to their wallet.
 *
 * State machine: idle → starting → live ⇄ (doubling) → (liquidated | closing) → settled → idle
 * The auto-close timer is client-side only; if the tab closes the position rides (isolated
 * margin caps the loss at the wagered collateral).
 */

const SLIPPAGE_BPS = 200;
const FILL_TIMEOUT_MS = 30_000; // how long to wait for the async magic_trade fill before giving up
const POLL_MS = 2_000; // effective live-phase poll cadence
const POLL_MS_STARTING = 700; // base interval; poll fast while "starting" to catch the fill quickly
const LIVE_POLL_EVERY = Math.max(1, Math.round(POLL_MS / POLL_MS_STARTING)); // throttle live polls to ≈POLL_MS
const LIQ_CONFIRM_POLLS = 2; // consecutive empty live polls before declaring a liquidation
const CLOSE_SETTLE_MS = 30_000; // how long to wait for close proceeds to land in the profile

type Phase = "idle" | "starting" | "live" | "closing" | "liquidated" | "settled";

interface Result {
  pnlUsd: number;
  claimableUsd: number;
  v2LedgerUsd: number;
  note?: string;
}

function errMsg(e: unknown): string {
  if (e instanceof ImperialError || e instanceof Error) return e.message;
  return String(e);
}

export default function DegenGame() {
  const signer = useSigner();
  const wallet = signer.publicKey;
  const { connection } = useConnection();

  const mark = useStatsStore((s) => s.marks[GAME_SYMBOL]);
  const jwt = useTraderStore((s) => s.jwt);
  const setJwt = useTraderStore((s) => s.setJwt);
  const setPositions = useTraderStore((s) => s.setPositions);
  const addToast = useToastStore((s) => s.addToast);
  const updateToast = useToastStore((s) => s.updateToast);

  const [phase, setPhase] = useState<Phase>("idle");
  const [side, setSide] = useState<GameSide>("long");
  const [stake, setStake] = useState("10");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [deadlineMs, setDeadlineMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [doubling, setDoubling] = useState(false);
  const [livePnl, setLivePnl] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [walletUsdc, setWalletUsdc] = useState<number | null>(null); // spendable USDC shown in the header
  const [gameV2Usd, setGameV2Usd] = useState(0); // game profile's V2-ledger collateral (idle surfacing)
  const [entries, setEntries] = useState<{ value: number; label: string }[]>([]); // per-tranche entry lines drawn on the chart

  // Refs read inside intervals (avoid stale closures).
  const phaseRef = useRef<Phase>("idle");
  const deadlineRef = useRef<number | null>(null);
  const doublingRef = useRef(false);
  const weClosedRef = useRef(false);
  const openAckAtRef = useRef<number | null>(null); // when openWithDeposit acked; for fill timeout
  const livePosRef = useRef<ReturnType<typeof findGamePosition> | null>(null);
  const liqMissRef = useRef(0); // consecutive empty position polls; guards against a false REKT
  const origStakeRef = useRef(0); // the first stake — every double-down repeats it
  const gameSideRef = useRef<GameSide>("long"); // locked at start; open/close/double-down all use it
  const lastPnlRef = useRef(0);
  const openFlowTidRef = useRef<string | null>(null); // open-flow toast id, resolved by the poll on live/timeout
  // Always points at the latest doClose so the ticker/double-down call the current closure.
  const doCloseRef = useRef<() => void>(() => {});
  const entriesRef = useRef<{ value: number; label: string }[]>([]); // mirrors `entries` for stale-free reads in polls/handlers
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { deadlineRef.current = deadlineMs; }, [deadlineMs]);
  useEffect(() => { entriesRef.current = entries; }, [entries]);

  const stakeNum = Number(stake) || 0;
  const stakeErr = validateStake(stakeNum);

  // ── live price feed (ref-counted; shared with /terminal if open) ─────────────
  useEffect(() => {
    marketData.start();
    marketData.setDepthSymbol(GAME_SYMBOL);
    return () => marketData.stop();
  }, []);

  // Hydrate a cached 30-day JWT so returning players skip the auth signature.
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

  const assertDepositReady = useCallback(async () => {
    if (!wallet) throw new Error("Connect a wallet first.");
    const { PublicKey } = await import("@solana/web3.js");
    const lamports = await connection.getBalance(new PublicKey(wallet)).catch(() => null);
    if (lamports != null && lamports < 0.005 * 1e9) {
      throw new Error(`Need a little SOL for gas (have ${(lamports / 1e9).toFixed(4)}).`);
    }
  }, [wallet, connection]);

  const confirm = useCallback(
    (sig: string) => confirmSignatureHttp(connection, sig),
    [connection]
  );

  const profileFreeNative = useCallback(async (token: string): Promise<number> => {
    const bals = await imperial.getBalances(token).catch(() => null);
    return bals?.profiles.find((p) => p.profileIndex === GAME_PROFILE)?.usdc ?? 0;
  }, []);

  const buildResult = useCallback(
    async (token: string, note?: string): Promise<Result> => {
      const free = await profileFreeNative(token);
      const v2 = await imperial
        .getV2Balance(token)
        .then((r) => r.profiles.find((p) => p.profileIndex === GAME_PROFILE)?.availableUsdc ?? 0)
        .catch(() => 0);
      return { pnlUsd: lastPnlRef.current, claimableUsd: free / 1e6, v2LedgerUsd: v2 / 1e6, note };
    },
    [profileFreeNative]
  );

  // ── header balance: spendable wallet USDC + the game profile's V2-ledger collateral ──
  // Refreshes on connect, at every phase boundary, and on a 10s visibility-gated poll so
  // the number deducts on stake, draws down as V2 collateral is reused, and rises on Claim
  // (matching player expectation). RPC failure shows "—", never throws.
  const refreshHeaderBalances = useCallback((isCancelled?: () => boolean) => {
    if (!wallet) { setWalletUsdc(null); setGameV2Usd(0); return; }
    void fetchWalletUsdc(wallet).then((v) => { if (!isCancelled?.()) setWalletUsdc(v); });
    const token = jwt ?? loadJwt(wallet);
    if (token) {
      void imperial
        .getV2Balance(token)
        .then((r) => r.profiles.find((p) => p.profileIndex === GAME_PROFILE)?.availableUsdc ?? 0)
        .catch(() => 0)
        .then((v) => { if (!isCancelled?.()) setGameV2Usd(v / 1e6); });
    }
  }, [wallet, jwt]);

  useEffect(() => {
    let cancelled = false;
    refreshHeaderBalances(() => cancelled);
    return () => { cancelled = true; };
  }, [refreshHeaderBalances, phase]);

  // Keep the header live as V2 collateral draws down: poll every 10s while a wallet is
  // connected, paused when the tab is hidden.
  useVisibilityInterval(() => refreshHeaderBalances(), 5_000, !!wallet);

  // ── auto-close ticker (drives countdown + fires the delegated close at deadline) ──
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
      if (
        phaseRef.current === "live" &&
        !doublingRef.current &&
        !weClosedRef.current &&
        deadlineRef.current != null &&
        Date.now() >= deadlineRef.current
      ) {
        weClosedRef.current = true;
        doCloseRef.current();
      }
    }, 200);
    return () => clearInterval(id);
  }, []);

  // ── position poll: fill detection, liquidation detection, live PnL, chart feed ──
  // Runs every POLL_MS_STARTING so a fill is caught fast; live-phase work is throttled
  // to ≈POLL_MS to keep request volume sane over a 60s+ position.
  useEffect(() => {
    let tick = 0;
    const id = setInterval(async () => {
      tick += 1;
      const p = phaseRef.current;
      if (p !== "starting" && p !== "live") return;
      if (p === "live" && tick % LIVE_POLL_EVERY !== 0) return;
      if (!wallet) return;
      let list;
      try {
        list = (await imperial.getPositions(wallet)).dataList ?? [];
      } catch {
        return;
      }
      setPositions(list); // keeps the chart's entry line fresh
      const pos = findGamePosition(list);

      if (phaseRef.current === "starting") {
        // Only treat a found position as OUR fill once the order is acked
        // (openAckAt set after openIncrement returns). Before that the poll must not
        // act: a stale leftover position in this profile would otherwise be adopted,
        // and — critically — resolving the toast mid-openIncrement orphans it when
        // start() then overwrites it. This makes openFlowTidRef coherently owned.
        if (pos && openAckAtRef.current != null) {
          liqMissRef.current = 0;
          livePosRef.current = pos;
          // Seed the chart's first entry line from the fill price (once).
          const entryPx = Number(pos.entryPrice);
          if (entryPx > 0 && entriesRef.current.length === 0) {
            setEntries([{ value: entryPx, label: "Entry" }]);
          }
          openAckAtRef.current = null; // filled — stop the fill-timeout clock
          const dl = initialDeadline(Date.now());
          deadlineRef.current = dl;
          setDeadlineMs(dl);
          // Resolve the open-flow toast — the poll owns it via the ref, so it never orphans.
          if (openFlowTidRef.current) {
            updateToast(openFlowTidRef.current, {
              type: "success",
              title: "Position live",
              detail: `${gameSideRef.current.toUpperCase()} $${formatPriceAuto(num(pos.sizeUsd))} @ ${GAME_LEVERAGE}×`,
            });
            openFlowTidRef.current = null;
          }
          setPhase("live");
          setBusy(false);
        } else if (openAckAtRef.current && Date.now() - openAckAtRef.current > FILL_TIMEOUT_MS) {
          // acked but never filled — stake is safe in the profile/V2 ledger
          openAckAtRef.current = null;
          if (openFlowTidRef.current) {
            updateToast(openFlowTidRef.current, { type: "info", title: "Didn't fill — stake safe", detail: "Order didn't fill in time." });
            openFlowTidRef.current = null;
          }
          const token = jwt ?? (wallet ? loadJwt(wallet) : null);
          setResult(token ? await buildResult(token, "Order didn't fill — your stake is safe.") : { pnlUsd: 0, claimableUsd: 0, v2LedgerUsd: 0, note: "Order didn't fill." });
          setPhase("settled");
          setBusy(false);
        }
        return;
      }

      // phase === "live"
      if (pos) {
        liqMissRef.current = 0;
        livePosRef.current = pos;
        // Fallback seed: if we reached live without an entry line (fast fill), seed it once.
        const entryPx = Number(pos.entryPrice);
        if (entryPx > 0 && entriesRef.current.length === 0) {
          setEntries([{ value: entryPx, label: "Entry" }]);
        }
        lastPnlRef.current = num(pos.pnlUsd);
        setLivePnl(num(pos.pnlUsd));
      } else if (!weClosedRef.current) {
        // The position is absent. A single empty read can be a transient indexer
        // blip, so require LIQ_CONFIRM_POLLS consecutive misses before calling it
        // a liquidation — otherwise a blip would falsely abandon a live 400× bet.
        liqMissRef.current += 1;
        if (liqMissRef.current >= LIQ_CONFIRM_POLLS) {
          setLivePnl(0);
          setEntries([]); // position gone — clear chart entry lines
          const token = jwt ?? (wallet ? loadJwt(wallet) : null);
          setResult(token ? await buildResult(token, "Liquidated.") : { pnlUsd: lastPnlRef.current, claimableUsd: 0, v2LedgerUsd: 0, note: "Liquidated." });
          setPhase("liquidated");
        }
      }
    }, POLL_MS_STARTING);
    return () => clearInterval(id);
  }, [wallet, jwt, setPositions, buildResult, updateToast]);

  // ── actions ──────────────────────────────────────────────────────────────────
  const openIncrement = useCallback(
    async (token: string, stakeUsd: number, tid: string, label: string) => {
      const px = useStatsStore.getState().marks[GAME_SYMBOL] ?? mark ?? 0;
      const input: OrderFormInput = {
        wallet: wallet!,
        profileIndex: GAME_PROFILE,
        symbol: GAME_SYMBOL,
        venue: GAME_VENUE,
        side: gameSideRef.current,
        type: "market",
        sizeUsd: sizeForStake(stakeUsd),
        collateralUsd: stakeUsd,
        markPrice: px,
        slippageBps: SLIPPAGE_BPS,
      };
      return openWithDeposit(input, {
        signer,
        jwt: token,
        venues: [GAME_VENUE],
        confirm,
        assertDepositReady,
        // 400× Flash V2 frequently bounces the first placement with a transient
        // "please try again"; lean harder on retries here than the terminal does.
        // Tightened delays for a fast game; the deposit-confirm is non-blocking and
        // the settle gate is V2-ledger-aware, so the deposit clears in seconds.
        orderRetries: 5,
        orderRetryMs: 600,
        resolveRetryMs: 1000,
        settleTimeoutMs: 15_000,
        onStep: (p) => updateToast(tid, { type: "loading", title: label, detail: p.message }),
      });
    },
    [wallet, mark, signer, confirm, assertDepositReady, updateToast]
  );

  const start = useCallback(async () => {
    if (busy || phase !== "idle" || !signer.isReady) return;
    if (stakeErr) { addToast("error", "Can't start", stakeErr); return; }
    setBusy(true);
    setResult(null);
    setEntries([]); // clear chart entry lines for the new round
    setPhase("starting");
    weClosedRef.current = false;
    livePosRef.current = null;
    liqMissRef.current = 0;
    openAckAtRef.current = null; // clear any stale ack from a prior round (else the poll false-times-out)
    origStakeRef.current = stakeNum;
    gameSideRef.current = side;
    lastPnlRef.current = 0;
    const tid = addToast("loading", `Opening ${side} ${GAME_LEVERAGE}× ${GAME_SYMBOL}…`, `$${stakeNum} → $${sizeForStake(stakeNum)} size`);
    openFlowTidRef.current = tid; // the poll resolves this on fill / fill-timeout
    try {
      const token = await ensureJwt();
      await openIncrement(token, stakeNum, tid, `Opening ${GAME_LEVERAGE}×`);
      openAckAtRef.current = Date.now(); // arms the poll's fill detection + timeout
      // Only show "Filling…" if the poll hasn't already claimed the toast (it can't until
      // now, but stay defensive: the ref is the single source of truth for ownership).
      if (openFlowTidRef.current === tid) {
        updateToast(tid, { type: "loading", title: "Filling…", detail: "Waiting for Flash V2 fill" });
      }
      // transition to "live" happens in the position poll when the fill lands
    } catch (e) {
      // If the poll already adopted a live position (lost the race to a fast fill), don't
      // clobber the live game with this late open error.
      if (phaseRef.current === "live") { setBusy(false); return; }
      openFlowTidRef.current = null; // we own the resolution here; don't let the poll touch it
      const safe = e instanceof TradeFlowError;
      // depositedNative === 0 ⇒ we bailed before funding (e.g. order bot offline);
      // nothing was staked, so don't claim "stake safe".
      const noDeposit = e instanceof TradeFlowError && e.depositedNative === 0;
      updateToast(tid, {
        type: safe ? "info" : "error",
        title: noDeposit ? "Can't open right now" : safe ? "Didn't open — stake safe" : "Open failed",
        detail: errMsg(e),
      });
      try {
        const token = await ensureJwt();
        setResult(await buildResult(token, safe && !noDeposit ? "Order didn't open — your stake is safe." : undefined));
        setPhase((await profileFreeNative(token)) > 0 ? "settled" : "idle");
      } catch { setPhase("idle"); }
      setBusy(false);
    }
  }, [busy, phase, signer.isReady, side, stakeErr, stakeNum, addToast, ensureJwt, openIncrement, updateToast, buildResult, profileFreeNative]);

  const doubleDown = useCallback(async () => {
    if (phase !== "live" || doublingRef.current || deadlineRef.current == null) return;
    doublingRef.current = true;
    setDoubling(true);
    // Optimistically extend the END by 60s and pause the auto-close while signing.
    const extended = extendDeadline(deadlineRef.current);
    deadlineRef.current = extended;
    setDeadlineMs(extended);
    const amt = origStakeRef.current;
    // Capture this tranche's entry line at the moment of the tap. Relabel the existing
    // first line to "Entry 1" so the set reads Entry 1 / Entry 2 / … (ref avoids stale state).
    const px = useStatsStore.getState().marks[GAME_SYMBOL] ?? mark ?? 0;
    if (px > 0) {
      const prev = entriesRef.current;
      const relabeled = prev.map((e, i) => (i === 0 ? { ...e, label: "Entry 1" } : e));
      setEntries([...relabeled, { value: px, label: `Entry ${prev.length + 1}` }]);
    }
    const tid = addToast("loading", "Doubling down…", `+$${amt} · +60s`);
    try {
      const token = await ensureJwt();
      await openIncrement(token, amt, tid, "Doubling down");
      updateToast(tid, { type: "success", title: "Doubled down", detail: `+$${amt} staked · +60s` });
    } catch (e) {
      // revert the optimistic extension
      const reverted = (deadlineRef.current ?? extended) - WINDOW_MS;
      deadlineRef.current = reverted;
      setDeadlineMs(reverted);
      updateToast(tid, { type: e instanceof TradeFlowError ? "info" : "error", title: "Double down failed", detail: errMsg(e) });
    } finally {
      doublingRef.current = false;
      setDoubling(false);
      // If the window elapsed while we were signing a failed double-down, close now.
      if (phaseRef.current === "live" && !weClosedRef.current && deadlineRef.current != null && Date.now() >= deadlineRef.current) {
        weClosedRef.current = true;
        doCloseRef.current();
      }
    }
  }, [phase, mark, addToast, ensureJwt, openIncrement, updateToast]);

  const doClose = useCallback(async () => {
    setPhase("closing");
    const tid = addToast("loading", "Time! Closing…", "no signature needed");
    // Once the close order is accepted the position is gone on-chain; from that point
    // a failure in the (best-effort) settle/result bookkeeping must NOT clobber the
    // success toast or re-open the now-closed position.
    let closed = false;
    try {
      const token = await ensureJwt();
      const pos = livePosRef.current;
      const sizeUsd = pos ? num(pos.sizeUsd) : 0;
      const px = useStatsStore.getState().marks[GAME_SYMBOL] ?? mark ?? 0;
      const req = buildCloseRequest({
        wallet: wallet!,
        profileIndex: GAME_PROFILE,
        symbol: GAME_SYMBOL,
        venue: GAME_VENUE,
        positionSide: gameSideRef.current,
        sizeUsd,
        markPrice: px,
        slippageBps: SLIPPAGE_BPS,
      });
      let res = await imperial.placeOrder(req, token);
      if (!res.success && isTransientResolveError(res.error)) {
        await new Promise((r) => setTimeout(r, 2500));
        res = await imperial.placeOrder(req, token);
      }
      if (!res.success) throw new Error(res.error ?? "Close rejected");
      closed = true;
      setEntries([]); // position closed on-chain — clear chart entry lines
      updateToast(tid, { type: "success", title: "Closed", detail: "Settling…" });
      // wait for proceeds to settle into the profile (best-effort)
      const preFree = await profileFreeNative(token);
      const start = Date.now();
      while (Date.now() - start < CLOSE_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, 2000));
        if ((await profileFreeNative(token)) > preFree) break;
      }
      setResult(await buildResult(token));
      setPhase("settled");
    } catch (e) {
      if (closed) {
        // Close already succeeded on-chain — only post-close bookkeeping failed.
        // Keep the success toast; land in settled (best-effort result), never re-arm live.
        try {
          const token = await ensureJwt();
          setResult(await buildResult(token));
          setPhase("settled");
        } catch {
          setPhase("idle");
        }
        return;
      }
      // close failed — the position is still open. Re-arm after a short backoff so the
      // ticker retries (rather than spinning every 200ms while the deadline is past).
      updateToast(tid, { type: "error", title: "Close failed — retrying", detail: errMsg(e) });
      setPhase("live");
      setTimeout(() => { weClosedRef.current = false; }, 3000);
    }
  }, [wallet, mark, addToast, ensureJwt, updateToast, profileFreeNative, buildResult]);

  // Keep the ref pointed at the latest doClose for the ticker / double-down to call.
  useEffect(() => { doCloseRef.current = () => void doClose(); }, [doClose]);

  const claim = useCallback(async () => {
    if (busy || !wallet) return;
    setBusy(true);
    const tid = addToast("loading", "Claiming to wallet…");
    try {
      const token = await ensureJwt();
      const native = await profileFreeNative(token);
      if (!(native > 0)) { updateToast(tid, { type: "info", title: "Nothing to claim", detail: "No free balance in the game profile." }); setBusy(false); return; }
      const { transaction } = await imperial.buildDepositTx({ wallet, profileIndex: GAME_PROFILE, amount: native, mode: "withdraw" });
      const { signature } = await signer.signAndSendTransaction({ kind: "solana-versioned", base64: transaction });
      void confirm(signature).catch(() => {}); // fire-and-forget; the withdraw is already submitted
      updateToast(tid, { type: "success", title: "Claimed to wallet", detail: `$${(native / 1e6).toFixed(2)} → wallet`, txid: signature });
      setPhase("idle");
      setResult(null);
      setDeadlineMs(null);
    } catch (e) {
      updateToast(tid, { type: "error", title: "Claim failed", detail: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [busy, wallet, addToast, ensureJwt, profileFreeNative, signer, confirm, updateToast]);

  const playAgain = useCallback(() => {
    setPhase("idle");
    setResult(null);
    setDeadlineMs(null);
    setLivePnl(0);
    setEntries([]); // clear chart entry lines
    weClosedRef.current = false;
    livePosRef.current = null;
    openFlowTidRef.current = null;
  }, []);

  // ── render ──────────────────────────────────────────────────────────────────
  const remain = deadlineMs ? remainingMs(deadlineMs, nowMs) : 0;
  const remainSec = remain / 1000;
  const countdownColor = remainSec > 20 ? "text-metric-buy" : remainSec > 7 ? "text-metric-primary" : "text-metric-sell";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* top bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-metric-border bg-surface-1 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-bold tracking-wide text-text-primary">DEGEN MODE</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary/60">{GAME_LEVERAGE}× · {GAME_SYMBOL} · 60s</span>
        </div>
        <div className="flex items-center gap-3">
          {signer.isReady && (
            <span className="font-mono text-[12px] text-text-secondary" title="Spendable wallet USDC">
              {walletUsdc != null ? `$${walletUsdc.toFixed(2)} USDC` : "—"}
            </span>
          )}
          <WalletMultiButton />
        </div>
      </div>

      {/* chart — overflow-hidden clips liveline's canvas to the flex box so it
          can't bleed over (and steal clicks from) the control panel below */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <LiveLineChart symbol={GAME_SYMBOL} entryLines={entries} />
        {/* live countdown overlay */}
        {(phase === "live" || phase === "closing") && deadlineMs != null && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 text-center">
            <div className={clsx("font-mono text-5xl font-bold tabular-nums", countdownColor)}>{formatCountdown(remain)}</div>
            <div className="mt-1 font-mono text-[11px] text-text-secondary">
              {livePnl !== 0 && (
                <span className={livePnl >= 0 ? "text-metric-buy" : "text-metric-sell"}>
                  {livePnl >= 0 ? "+" : ""}${livePnl.toFixed(2)} ·{" "}
                </span>
              )}
              {livePosRef.current ? (
                <span className={gameSideRef.current === "long" ? "text-metric-buy" : "text-metric-sell"}>
                  {gameSideRef.current.toUpperCase()}
                </span>
              ) : null}
              {livePosRef.current ? ` · $${formatPriceAuto(num(livePosRef.current.sizeUsd))} @ ${GAME_LEVERAGE}×` : ""}
            </div>
          </div>
        )}
      </div>

      {/* control panel — relative z-10 keeps it above the chart layer so its
          buttons always receive clicks even if the canvas overdraws its box */}
      <div className="relative z-10 shrink-0 border-t border-metric-border bg-surface-1 px-4 py-3">
        {phase === "idle" && gameV2Usd > 0.01 && (
          <div className="mb-2 font-mono text-[10px] text-text-secondary/70">
            ${gameV2Usd.toFixed(2)} in Flash V2 collateral — applied to your next trade.
          </div>
        )}
        <ControlPanel
          phase={phase}
          busy={busy}
          doubling={doubling}
          side={side}
          setSide={setSide}
          stake={stake}
          setStake={setStake}
          stakeErr={stakeErr}
          stakeNum={stakeNum}
          isReady={signer.isReady}
          origStake={origStakeRef.current}
          result={result}
          onStart={start}
          onDoubleDown={doubleDown}
          onClaim={claim}
          onPlayAgain={playAgain}
        />
      </div>

      <Toasts />
    </div>
  );
}

function ControlPanel(props: {
  phase: Phase;
  busy: boolean;
  doubling: boolean;
  side: GameSide;
  setSide: (s: GameSide) => void;
  stake: string;
  setStake: (v: string) => void;
  stakeErr: string | null;
  stakeNum: number;
  isReady: boolean;
  origStake: number;
  result: Result | null;
  onStart: () => void;
  onDoubleDown: () => void;
  onClaim: () => void;
  onPlayAgain: () => void;
}) {
  const { phase, busy, doubling, side, setSide, stake, setStake, stakeErr, stakeNum, isReady, origStake, result } = props;
  const isLong = side === "long";

  if (phase === "starting") {
    return <Center>{busy ? "Opening…" : "Waiting for fill…"} <span className="text-text-secondary/60">($ {origStake} staked)</span></Center>;
  }
  if (phase === "closing") {
    return <Center>Time! Closing your position…</Center>;
  }
  if (phase === "live") {
    return (
      <button
        onClick={props.onDoubleDown}
        disabled={doubling}
        className="w-full bg-metric-primary py-3 font-mono text-[15px] font-bold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {doubling ? "Doubling down…" : `Double Down — +$${origStake} · +60s`}
      </button>
    );
  }
  if (phase === "liquidated") {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="font-mono text-lg font-bold text-metric-sell">REKT 💀</div>
        <div className="font-mono text-[11px] text-text-secondary">Your 400× position was liquidated.{result?.claimableUsd ? ` $${result.claimableUsd.toFixed(2)} left to claim.` : ""}</div>
        <V2RecoveryNote usd={result?.v2LedgerUsd ?? 0} />
        <div className="flex gap-2">
          {result && result.claimableUsd > 0 && <ClaimBtn amount={result.claimableUsd} busy={busy} onClick={props.onClaim} />}
          <button onClick={props.onPlayAgain} className="border border-metric-border px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-text-secondary hover:text-text-primary">Play again</button>
        </div>
      </div>
    );
  }
  if (phase === "settled") {
    const won = (result?.pnlUsd ?? 0) >= 0;
    return (
      <div className="flex flex-col items-center gap-2">
        <div className={clsx("font-mono text-lg font-bold", won ? "text-metric-buy" : "text-metric-sell")}>
          {result?.note ?? (won ? "You survived! 🎉" : "Closed at a loss")}
        </div>
        <div className="font-mono text-[11px] text-text-secondary">
          {result?.pnlUsd ? `PnL ${result.pnlUsd >= 0 ? "+" : ""}$${result.pnlUsd.toFixed(2)} · ` : ""}
          Claimable ${result?.claimableUsd.toFixed(2) ?? "0.00"}
        </div>
        <V2RecoveryNote usd={result?.v2LedgerUsd ?? 0} />
        <div className="flex gap-2">
          {result && result.claimableUsd > 0 && <ClaimBtn amount={result.claimableUsd} busy={busy} onClick={props.onClaim} />}
          <button onClick={props.onPlayAgain} className="border border-metric-border px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-text-secondary hover:text-text-primary">Play again</button>
        </div>
      </div>
    );
  }

  // idle
  return (
    <div className="flex items-end gap-3">
      {/* side toggle — picks the bet direction; same 400×/60s mechanics either way */}
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">Side</div>
        <div className="flex">
          <button
            onClick={() => setSide("long")}
            className={clsx(
              "border px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-wider transition-colors",
              isLong
                ? "border-metric-buy bg-metric-buy text-metric-bg"
                : "border-metric-border text-text-secondary hover:text-text-primary"
            )}
          >
            Long
          </button>
          <button
            onClick={() => setSide("short")}
            className={clsx(
              "border border-l-0 px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-wider transition-colors",
              !isLong
                ? "border-metric-sell bg-metric-sell text-metric-bg"
                : "border-metric-border text-text-secondary hover:text-text-primary"
            )}
          >
            Short
          </button>
        </div>
      </div>
      <label className="flex-1">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-secondary/70">Stake (USDC) · min ${MIN_STAKE_USD}</div>
        <div className="flex items-center border border-metric-border bg-metric-bg px-2">
          <span className="font-mono text-sm text-text-secondary/60">$</span>
          <input
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            placeholder={String(MIN_STAKE_USD)}
            className="w-full bg-transparent px-1 py-2 font-mono text-sm text-text-primary outline-none"
          />
          <span className="whitespace-nowrap font-mono text-[10px] text-text-secondary/50">→ ${stakeNum > 0 ? formatPriceAuto(sizeForStake(stakeNum)) : "0"} @ {GAME_LEVERAGE}×</span>
        </div>
      </label>
      {!isReady ? (
        <WalletMultiButton />
      ) : (
        <button
          onClick={props.onStart}
          disabled={busy || !!stakeErr}
          title={stakeErr ?? undefined}
          className={clsx(
            "px-6 py-2.5 font-mono text-[14px] font-bold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50",
            isLong ? "bg-metric-buy" : "bg-metric-sell"
          )}
        >
          {busy ? "…" : `${isLong ? "Long" : "Short"} ${GAME_LEVERAGE}×`}
        </button>
      )}
    </div>
  );
}

function ClaimBtn({ amount, busy, onClick }: { amount: number; busy: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={busy} className="bg-metric-buy px-4 py-2 font-mono text-[12px] font-bold uppercase tracking-wider text-metric-bg transition-opacity hover:opacity-90 disabled:opacity-50">
      {busy ? "Claiming…" : `Claim $${amount.toFixed(2)}`}
    </button>
  );
}

function V2RecoveryNote({ usd }: { usd: number }) {
  if (!(usd > 0.01)) return null;
  return (
    <div className="font-mono text-[10px] text-text-secondary/60">
      ${usd.toFixed(2)} in Flash V2 collateral — applied to your next trade.
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-center font-mono text-[13px] text-text-secondary">{children}</div>;
}
