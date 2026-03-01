"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useMarketStore } from "@/stores/marketStore";
import { useOrderbookStore } from "@/stores/orderbookStore";
import { useTraderStore } from "@/stores/traderStore";
import { useStatsStore } from "@/stores/statsStore";
import { useTransactionBuilder } from "@/hooks/useTransactionBuilder";
import { useToastStore } from "@/stores/toastStore";
import { useUiStore } from "@/stores/uiStore";
import { formatUsd, formatPrice } from "@/lib/format";
import { MarginMode } from "@/types/trader";
import clsx from "clsx";

export function OrderEntry() {
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [collateralInput, setCollateralInput] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [showTpSl, setShowTpSl] = useState(false);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [txPhase, setTxPhase] = useState<"idle" | "building" | "simulating" | "signing" | "submitting">("idle");
  const submittingRef = useRef(false);
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const marketConfig = useMarketStore((s) => s.marketConfig);
  const markPrice = useStatsStore((s) => s.stats?.mark_price) ?? 0;
  const { submitOrder, submitIsolatedOrder, connected } = useTransactionBuilder();
  const addToast = useToastStore((s) => s.addToast);

  // Consume focusSide from keyboard shortcuts
  const focusSide = useUiStore((s) => s.focusSide);
  const setFocusSide = useUiStore((s) => s.setFocusSide);

  useEffect(() => {
    if (focusSide) {
      setSide(focusSide);
      setFocusSide(null);
    }
  }, [focusSide, setFocusSide]);

  // Listen for orderbook click-to-fill
  const fillPrice = useOrderbookStore((s) => s.fillPrice);
  const setFillPrice = useOrderbookStore((s) => s.setFillPrice);

  useEffect(() => {
    if (fillPrice !== null) {
      setPrice(fillPrice.toString());
      if (orderType === "market") setOrderType("limit");
      setFillPrice(null);
    }
  }, [fillPrice, orderType, setFillPrice]);

  // Reset when market changes
  useEffect(() => {
    setLeverage(1);
    setMarginMode("cross");
    setCollateralInput("");
    setShowTpSl(false);
    setTpPrice("");
    setSlPrice("");
  }, [selectedSymbol]);

  // Trader account info
  const collateral = useTraderStore((s) => s.collateral);
  const portfolioValue = useTraderStore((s) => s.portfolioValue);
  const initialMargin = useTraderStore((s) => s.initialMargin);
  const unrealizedPnl = useTraderStore((s) => s.unrealizedPnl);
  const riskState = useTraderStore((s) => s.riskState);

  // Free collateral = total collateral minus what's already locked by open positions.
  // This is what's actually available for new trades on-chain.
  const freeCollateral = Math.max(0, collateral - initialMargin);

  // TP/SL validation
  const tpValid = useMemo(() => {
    const tp = parseFloat(tpPrice);
    if (!tpPrice || isNaN(tp) || tp <= 0 || !markPrice) return true;
    return side === "buy" ? tp > markPrice : tp < markPrice;
  }, [tpPrice, markPrice, side]);

  const slValid = useMemo(() => {
    const sl = parseFloat(slPrice);
    if (!slPrice || isNaN(sl) || sl <= 0 || !markPrice) return true;
    return side === "buy" ? sl < markPrice : sl > markPrice;
  }, [slPrice, markPrice, side]);

  const lotSize = useMemo(() => 10 ** -(marketConfig?.baseLotsDecimals || 2), [marketConfig]);
  const maxLeverage = marketConfig?.maxLeverage || 10;

  // 3% safety buffer: marks price can move between simulation and on-chain execution.
  // Without buffer, a 1-2% price move causes margin check to fail with Custom:6001.
  const POSITION_SAFETY_BUFFER = 0.97;

  // Derive order from collateral + leverage
  const derivedOrder = useMemo(() => {
    const col = parseFloat(collateralInput || "0");
    if (col <= 0 || !markPrice || markPrice <= 0) return null;

    const effectivePrice = (orderType === "limit" && price)
      ? parseFloat(price) : markPrice;
    if (!effectivePrice || effectivePrice <= 0 || isNaN(effectivePrice)) return null;

    const notional = col * leverage;
    const baseSize = notional / effectivePrice;
    // Apply safety buffer to prevent on-chain InsufficientFunds (Custom:6001) when
    // mark price moves between our pre-flight simulation and actual on-chain execution.
    const sizeLots = Math.floor(baseSize * POSITION_SAFETY_BUFFER / lotSize);
    if (sizeLots <= 0) return null;

    // Snap to lot grid
    const adjBaseSize = sizeLots * lotSize;
    const adjNotional = adjBaseSize * effectivePrice;

    // Approximate liquidation price (~2.5% maintenance margin ratio)
    const mmr = 0.025;
    const liqPrice = side === "buy"
      ? effectivePrice * (1 - 1 / leverage + mmr)
      : effectivePrice * (1 + 1 / leverage - mmr);

    return {
      collateral: col,
      notional: adjNotional,
      baseSize: adjBaseSize,
      sizeLots,
      effectivePrice,
      liqPrice: leverage > 1 ? liqPrice : null,
    };
  }, [collateralInput, leverage, markPrice, orderType, price, lotSize, side]);

  // Leverage breakpoints
  const leverageBreakpoints = useMemo(() => {
    const pts: number[] = [1];
    const step = Math.max(1, Math.floor(maxLeverage / 4));
    for (let i = step; i < maxLeverage; i += step) {
      if (!pts.includes(i)) pts.push(i);
    }
    if (!pts.includes(maxLeverage)) pts.push(maxLeverage);
    return pts;
  }, [maxLeverage]);

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    if (!connected || !derivedOrder) return;
    if (orderType === "limit" && (!price || parseFloat(price) <= 0)) return;
    if (showTpSl && (!tpValid || !slValid)) return;

    // Pre-flight margin check — compare against FREE collateral (total minus locked)
    if (collateral <= 0) {
      addToast("error", "No Collateral", "Deposit USDC before trading.");
      return;
    }
    if (derivedOrder.collateral > freeCollateral) {
      addToast("error", "Insufficient Margin", `Need $${derivedOrder.collateral.toFixed(2)} but only $${freeCollateral.toFixed(2)} free (${formatUsd(initialMargin)} locked by open positions). Reduce size or close positions.`);
      return;
    }

    submittingRef.current = true;
    setTxPhase("building");
    try {
      const params: any = {
        symbol: selectedSymbol,
        side: side === "buy" ? "bid" : "ask",
        size_lots: derivedOrder.sizeLots,
      };
      if (orderType === "limit") {
        params.price = parseFloat(price);
      }
      if (showTpSl) {
        const tp = parseFloat(tpPrice);
        const sl = parseFloat(slPrice);
        if (!isNaN(tp) && tp > 0) params.take_profit_price = tp;
        if (!isNaN(sl) && sl > 0) params.stop_loss_price = sl;
      }
      if (marginMode === "isolated") {
        params.collateral_usdc = derivedOrder.collateral;
        await submitIsolatedOrder(orderType, params, (status) => setTxPhase(status));
      } else {
        await submitOrder(orderType, params, (status) => setTxPhase(status));
      }
      setCollateralInput("");
      setTpPrice("");
      setSlPrice("");
      setShowTpSl(false);
    } catch (e: any) {
      console.error("Order failed:", e);
    } finally {
      setTxPhase("idle");
      submittingRef.current = false;
    }
  };

  const baseDecimals = marketConfig?.baseLotsDecimals || 2;

  return (
    <>
      <div className="flex h-full flex-col">
        <div className="flex flex-col gap-3 p-3">
          {/* Order type tabs */}
          <div className="flex border-b border-ember-border/50">
            {(["limit", "market"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setOrderType(t)}
                className={clsx(
                  "px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                  orderType === t
                    ? "border-b border-ember-orange text-text-primary"
                    : "text-text-secondary/60 hover:text-text-secondary"
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Side toggle */}
          <div className="grid grid-cols-2 gap-px bg-ember-border">
            <button
              onClick={() => setSide("buy")}
              className={clsx(
                "py-2 font-mono text-[11px] font-medium tracking-wider transition-all duration-150",
                side === "buy"
                  ? "bg-ember-green text-ember-black"
                  : "bg-surface-l2 text-text-secondary/60 hover:text-text-secondary"
              )}
            >
              BUY / LONG
            </button>
            <button
              onClick={() => setSide("sell")}
              className={clsx(
                "py-2 font-mono text-[11px] font-medium tracking-wider transition-all duration-150",
                side === "sell"
                  ? "bg-ember-red text-white"
                  : "bg-surface-l2 text-text-secondary/60 hover:text-text-secondary"
              )}
            >
              SELL / SHORT
            </button>
          </div>

          {/* Margin mode toggle */}
          <div className="grid grid-cols-2 gap-px bg-ember-border">
            {(["cross", "isolated"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setMarginMode(mode)}
                className={clsx(
                  "py-1.5 font-mono text-[10px] uppercase tracking-wider transition-all duration-150",
                  marginMode === mode
                    ? "bg-ember-orange text-white"
                    : "bg-surface-l2 text-text-secondary/60 hover:text-text-secondary"
                )}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* Collateral input (USDC) */}
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-text-secondary/70 uppercase">
              Collateral
            </label>
            <div className="relative">
              <input
                type="number"
                value={collateralInput}
                onChange={(e) => setCollateralInput(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.01"
                className="w-full border border-ember-border bg-surface-l2 py-2 pl-3 pr-12 font-mono text-[11px] text-text-primary placeholder:text-text-secondary/40 focus:border-ember-orange/60 focus:outline-none transition-colors"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-secondary/60">
                USDC
              </span>
            </div>
            <div className="mt-1 flex gap-1">
              {[10, 25, 50, 100].map((pct) => (
                <button
                  key={pct}
                  onClick={() => {
                    if (freeCollateral > 0) {
                      setCollateralInput(((freeCollateral * pct) / 100).toFixed(2));
                    }
                  }}
                  className="flex-1 py-1 font-mono text-[9px] text-text-secondary/60 bg-surface-l2 border border-ember-border/30 hover:text-ember-orange hover:border-ember-orange/40 transition-colors"
                >
                  {pct}%
                </button>
              ))}
            </div>
          </div>

          {/* Price input (limit only) */}
          {orderType === "limit" && (
            <div>
              <label className="mb-1 block text-[10px] tracking-wider text-text-secondary/70 uppercase">
                Price
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  className="w-full border border-ember-border bg-surface-l2 py-2 pl-3 pr-12 font-mono text-[11px] text-text-primary placeholder:text-text-secondary/40 focus:border-ember-orange/60 focus:outline-none transition-colors"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-secondary/60">
                  USD
                </span>
              </div>
            </div>
          )}

          {/* Leverage slider with +/- buttons and breakpoints */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] tracking-wider text-text-secondary/70 uppercase">
                Leverage
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setLeverage((l) => Math.max(1, l - 1))}
                  className="h-5 w-5 flex items-center justify-center border border-ember-border bg-surface-l2 font-mono text-[11px] text-text-secondary hover:text-ember-orange hover:border-ember-orange/40 transition-colors"
                >
                  -
                </button>
                <span className="font-mono text-[11px] text-ember-orange min-w-[28px] text-center">{leverage}x</span>
                <button
                  onClick={() => setLeverage((l) => Math.min(maxLeverage, l + 1))}
                  className="h-5 w-5 flex items-center justify-center border border-ember-border bg-surface-l2 font-mono text-[11px] text-text-secondary hover:text-ember-orange hover:border-ember-orange/40 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
            <input
              type="range"
              min={1}
              max={maxLeverage}
              step={1}
              value={leverage}
              onChange={(e) => setLeverage(parseInt(e.target.value))}
              className="w-full accent-ember-orange"
            />
            <div className="flex justify-between mt-0.5">
              {leverageBreakpoints.map((bp) => (
                <button
                  key={bp}
                  onClick={() => setLeverage(bp)}
                  className={clsx(
                    "text-[9px] font-mono transition-colors",
                    leverage === bp ? "text-ember-orange" : "text-text-secondary/50 hover:text-text-secondary"
                  )}
                >
                  {bp}x
                </button>
              ))}
            </div>
          </div>

          {/* TP/SL toggle + inputs */}
          <div>
            <button
              onClick={() => setShowTpSl(!showTpSl)}
              className="flex w-full items-center justify-between py-1"
            >
              <span className="text-[10px] tracking-wider text-text-secondary/70 uppercase">
                TP / SL
              </span>
              <div className={clsx(
                "h-3 w-6 rounded-full transition-colors",
                showTpSl ? "bg-ember-orange" : "bg-ember-border"
              )}>
                <div className={clsx(
                  "h-3 w-3 rounded-full bg-white transition-transform",
                  showTpSl ? "translate-x-3" : "translate-x-0"
                )} />
              </div>
            </button>

            {showTpSl && (
              <div className="mt-2 flex flex-col gap-2">
                {/* Take Profit */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] tracking-wider text-text-secondary/70 uppercase">
                      Take Profit
                    </label>
                    {tpPrice && markPrice > 0 && (
                      <span className="font-mono text-[10px] text-ember-green">
                        Est. PnL: +${formatPrice(Math.abs((parseFloat(tpPrice) - markPrice) * (derivedOrder?.baseSize || 0)))}
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      value={tpPrice}
                      onChange={(e) => setTpPrice(e.target.value)}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      className={clsx(
                        "w-full border bg-surface-l2 py-2 pl-3 pr-12 font-mono text-[11px] text-text-primary placeholder:text-text-secondary/40 focus:outline-none transition-colors",
                        !tpValid ? "border-ember-red focus:border-ember-red" : "border-ember-border focus:border-ember-orange/60"
                      )}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-secondary/60">
                      USD
                    </span>
                  </div>
                  <div className="mt-1 flex gap-1">
                    {[2.5, 5, 10].map((pct) => (
                      <button
                        key={pct}
                        onClick={() => {
                          if (markPrice > 0) {
                            const offset = markPrice * (pct / 100);
                            const tp = side === "buy" ? markPrice + offset : markPrice - offset;
                            setTpPrice(tp.toFixed(2));
                          }
                        }}
                        className="flex-1 py-1 font-mono text-[9px] text-text-secondary/60 bg-surface-l2 border border-ember-border/30 hover:text-ember-green hover:border-ember-green/40 transition-colors"
                      >
                        +{pct}%
                      </button>
                    ))}
                  </div>
                  {!tpValid && (
                    <span className="mt-0.5 text-[9px] text-ember-red">
                      TP must be {side === "buy" ? "above" : "below"} mark price
                    </span>
                  )}
                </div>

                {/* Stop Loss */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] tracking-wider text-text-secondary/70 uppercase">
                      Stop Loss
                    </label>
                    {slPrice && markPrice > 0 && (
                      <span className="font-mono text-[10px] text-ember-red">
                        Est. PnL: -${formatPrice(Math.abs((parseFloat(slPrice) - markPrice) * (derivedOrder?.baseSize || 0)))}
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      value={slPrice}
                      onChange={(e) => setSlPrice(e.target.value)}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      className={clsx(
                        "w-full border bg-surface-l2 py-2 pl-3 pr-12 font-mono text-[11px] text-text-primary placeholder:text-text-secondary/40 focus:outline-none transition-colors",
                        !slValid ? "border-ember-red focus:border-ember-red" : "border-ember-border focus:border-ember-orange/60"
                      )}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-secondary/60">
                      USD
                    </span>
                  </div>
                  <div className="mt-1 flex gap-1">
                    {[2.5, 5, 10].map((pct) => (
                      <button
                        key={pct}
                        onClick={() => {
                          if (markPrice > 0) {
                            const offset = markPrice * (pct / 100);
                            const sl = side === "buy" ? markPrice - offset : markPrice + offset;
                            setSlPrice(sl.toFixed(2));
                          }
                        }}
                        className="flex-1 py-1 font-mono text-[9px] text-text-secondary/60 bg-surface-l2 border border-ember-border/30 hover:text-ember-red hover:border-ember-red/40 transition-colors"
                      >
                        -{pct}%
                      </button>
                    ))}
                  </div>
                  {!slValid && (
                    <span className="mt-0.5 text-[9px] text-ember-red">
                      SL must be {side === "buy" ? "below" : "above"} mark price
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Order summary */}
          {derivedOrder && (
            <div className="flex flex-col gap-1 border border-ember-border/30 bg-surface-l2/30 p-2">
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Position Size</span>
                <span className="font-mono text-[10px] text-text-primary">
                  {derivedOrder.baseSize.toFixed(baseDecimals)} {selectedSymbol}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Notional Value</span>
                <span className="font-mono text-[10px] text-text-primary">${formatPrice(derivedOrder.notional)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Est. Entry Price</span>
                <span className="font-mono text-[10px] text-text-primary">${formatPrice(derivedOrder.effectivePrice)}</span>
              </div>
              {derivedOrder.liqPrice !== null && (
                <div className="flex justify-between">
                  <span className="text-[10px] text-text-secondary/70">Est. Liq. Price</span>
                  <span className="font-mono text-[10px] text-ember-red">${formatPrice(derivedOrder.liqPrice)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Collateral</span>
                <span className="font-mono text-[10px] text-text-primary">${formatPrice(derivedOrder.collateral)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Eff. Leverage</span>
                <span className="font-mono text-[10px] text-ember-orange">
                  {(derivedOrder.notional / derivedOrder.collateral).toFixed(1)}x
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Mode</span>
                <span className={clsx(
                  "font-mono text-[10px]",
                  marginMode === "isolated" ? "text-ember-orange" : "text-text-secondary"
                )}>
                  {marginMode.toUpperCase()}
                </span>
              </div>
              {showTpSl && tpPrice && (
                <div className="flex justify-between">
                  <span className="text-[10px] text-text-secondary/70">TP</span>
                  <span className="font-mono text-[10px] text-ember-green">
                    ${formatPrice(parseFloat(tpPrice))}
                    {markPrice > 0 && (
                      <span className="text-text-secondary/50 ml-1">
                        ({side === "buy" ? "+" : "-"}{((Math.abs(parseFloat(tpPrice) - markPrice) / markPrice) * 100).toFixed(1)}%)
                      </span>
                    )}
                  </span>
                </div>
              )}
              {showTpSl && slPrice && (
                <div className="flex justify-between">
                  <span className="text-[10px] text-text-secondary/70">SL</span>
                  <span className="font-mono text-[10px] text-ember-red">
                    ${formatPrice(parseFloat(slPrice))}
                    {markPrice > 0 && (
                      <span className="text-text-secondary/50 ml-1">
                        ({side === "buy" ? "-" : "+"}{((Math.abs(parseFloat(slPrice) - markPrice) / markPrice) * 100).toFixed(1)}%)
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Submit button — Jupiter-style with computed size + notional */}
          <button
            onClick={handleSubmit}
            disabled={!connected || !derivedOrder || txPhase !== "idle" || (orderType === "limit" && (!price || parseFloat(price) <= 0)) || (showTpSl && (!tpValid || !slValid))}
            className={clsx(
              "flex w-full items-center justify-center gap-2 py-2.5 font-mono text-[11px] font-medium tracking-wider transition-all duration-150",
              !connected
                ? "bg-surface-l2 text-text-secondary/50 cursor-not-allowed"
                : side === "buy"
                  ? "bg-ember-green text-ember-black hover:brightness-110 active:brightness-95"
                  : "bg-ember-red text-white hover:brightness-110 active:brightness-95",
              txPhase !== "idle" && "opacity-70 pointer-events-none"
            )}
          >
            {txPhase !== "idle" && (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
                <path d="M8 2a6 6 0 014.9 9.4" />
              </svg>
            )}
            {!connected
              ? "CONNECT WALLET"
              : txPhase === "building"
                ? "BUILDING..."
                : txPhase === "simulating"
                  ? "SIMULATING..."
                  : txPhase === "signing"
                    ? "SIGNING..."
                    : txPhase === "submitting"
                      ? "SUBMITTING..."
                      : derivedOrder
                        ? `${side === "buy" ? "LONG" : "SHORT"} ${derivedOrder.baseSize.toFixed(baseDecimals)} ${selectedSymbol} ≈ $${formatPrice(derivedOrder.notional)}`
                        : side === "buy"
                          ? `BUY ${selectedSymbol}`
                          : `SELL ${selectedSymbol}`}
          </button>
        </div>

        {/* Account info — shown when wallet connected */}
        {connected && (
          <div className="mt-auto border-t border-ember-border/50 p-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-text-secondary/70">Collateral</span>
                <span className="font-mono text-[11px] text-text-primary">{formatUsd(collateral)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-ember-orange/80">Available</span>
                <span className="font-mono text-[11px] text-ember-orange">{formatUsd(freeCollateral)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-text-secondary/70">Portfolio</span>
                <span className="font-mono text-[11px] text-text-secondary">{formatUsd(portfolioValue)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-text-secondary/70">Init Margin</span>
                <span className="font-mono text-[11px] text-text-secondary">{formatUsd(initialMargin)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-text-secondary/70">Unreal. PnL</span>
                <span className={clsx(
                  "font-mono text-[11px]",
                  unrealizedPnl >= 0 ? "text-ember-green" : "text-ember-red"
                )}>
                  {unrealizedPnl >= 0 ? "+" : ""}{formatUsd(unrealizedPnl)}
                </span>
              </div>
              {riskState && riskState !== "Healthy" && riskState !== "ZeroCollateralNoPositions" && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-text-secondary/70">Risk</span>
                  <span className="font-mono text-[10px] text-ember-red">{riskState}</span>
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </>
  );
}
