"use client";

import { useState, useEffect, useMemo } from "react";
import { useMarketStore } from "@/stores/marketStore";
import { useOrderbookStore } from "@/stores/orderbookStore";
import { useTraderStore } from "@/stores/traderStore";
import { useStatsStore } from "@/stores/statsStore";
import { useTransactionBuilder } from "@/hooks/useTransactionBuilder";
import { useToastStore } from "@/stores/toastStore";
import { formatUsd, formatPrice } from "@/lib/format";
import { DepositWithdraw } from "./DepositWithdraw";
import clsx from "clsx";

export function OrderEntry() {
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [txPhase, setTxPhase] = useState<"idle" | "building" | "simulating" | "signing" | "submitting">("idle");
  const [showDeposit, setShowDeposit] = useState(false);
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const marketConfig = useMarketStore((s) => s.marketConfig);
  const markPrice = useStatsStore((s) => s.stats?.mark_price);
  const { submitOrder, connected } = useTransactionBuilder();
  const addToast = useToastStore((s) => s.addToast);

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

  // Reset leverage when market changes (new maxLeverage may be different)
  useEffect(() => {
    setLeverage(1);
  }, [selectedSymbol]);

  // Trader account info (SDK TraderView fields)
  const collateral = useTraderStore((s) => s.collateral);
  const portfolioValue = useTraderStore((s) => s.portfolioValue);
  const initialMargin = useTraderStore((s) => s.initialMargin);
  const unrealizedPnl = useTraderStore((s) => s.unrealizedPnl);
  const riskState = useTraderStore((s) => s.riskState);

  // Order summary calculations
  const lotSize = useMemo(() => 10 ** -(marketConfig?.baseLotsDecimals || 2), [marketConfig]);
  const orderSummary = useMemo(() => {
    const baseSize = parseFloat(size || "0");
    if (baseSize <= 0 || !markPrice || markPrice <= 0) return null;
    const notional = baseSize * markPrice;
    const requiredMargin = notional / leverage;
    return { baseSize, notional, requiredMargin };
  }, [size, markPrice, leverage]);

  const handleSubmit = async () => {
    if (!connected || !size) return;
    // Guard against empty price on limit orders
    if (orderType === "limit" && (!price || parseFloat(price) <= 0)) return;
    const baseSize = parseFloat(size);
    if (isNaN(baseSize) || baseSize <= 0) return;
    const sizeLots = Math.round(baseSize / lotSize);
    if (sizeLots <= 0) return;
    setTxPhase("building");
    try {
      const params: any = {
        symbol: selectedSymbol,
        side: side === "buy" ? "bid" : "ask",
        size_lots: sizeLots,
      };
      if (orderType === "limit") {
        params.price = parseFloat(price);
      }
      await submitOrder(orderType, params, (status) => setTxPhase(status));
      addToast("success", `${side.toUpperCase()} ${orderType} order submitted`);
      setSize("");
    } catch (e: any) {
      console.error("Order failed:", e);
      addToast("error", e?.message || "Order failed");
    } finally {
      setTxPhase("idle");
    }
  };

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

          {/* Leverage slider */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] tracking-wider text-text-secondary/70 uppercase">
                Leverage
              </label>
              <span className="font-mono text-[11px] text-ember-orange">{leverage}x</span>
            </div>
            <input
              type="range"
              min={1}
              max={marketConfig?.maxLeverage || 10}
              step={1}
              value={leverage}
              onChange={(e) => setLeverage(parseInt(e.target.value))}
              className="w-full accent-ember-orange"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-[9px] text-text-secondary/50">1x</span>
              <span className="text-[9px] text-text-secondary/50">{marketConfig?.maxLeverage || 10}x</span>
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

          {/* Size input (base units) */}
          <div>
            <label className="mb-1 block text-[10px] tracking-wider text-text-secondary/70 uppercase">
              Size
            </label>
            <div className="relative">
              <input
                type="number"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="0.00"
                min={lotSize}
                step={lotSize}
                className="w-full border border-ember-border bg-surface-l2 py-2 pl-3 pr-12 font-mono text-[11px] text-text-primary placeholder:text-text-secondary/40 focus:border-ember-orange/60 focus:outline-none transition-colors"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-secondary/60">
                {selectedSymbol}
              </span>
            </div>
          </div>

          {/* Order summary */}
          {orderSummary && (
            <div className="flex flex-col gap-1 border border-ember-border/30 bg-surface-l2/30 p-2">
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Size</span>
                <span className="font-mono text-[10px] text-text-primary">
                  {orderSummary.baseSize.toFixed(marketConfig?.baseLotsDecimals || 2)} {selectedSymbol}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Notional</span>
                <span className="font-mono text-[10px] text-text-primary">${formatPrice(orderSummary.notional)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Est. Margin</span>
                <span className="font-mono text-[10px] text-text-primary">${formatPrice(orderSummary.requiredMargin)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-text-secondary/70">Eff. Leverage</span>
                <span className="font-mono text-[10px] text-ember-orange">
                  {collateral > 0 ? (orderSummary.notional / collateral).toFixed(1) : "—"}x
                </span>
              </div>
            </div>
          )}

          {/* Submit button */}
          <button
            onClick={handleSubmit}
            disabled={!connected || !size || txPhase !== "idle" || (orderType === "limit" && (!price || parseFloat(price) <= 0))}
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

            {/* Deposit / Withdraw button */}
            <button
              onClick={() => setShowDeposit(true)}
              className="mt-3 w-full border border-ember-border py-2 font-mono text-[10px] uppercase tracking-wider text-text-secondary transition-colors hover:border-ember-orange/40 hover:text-ember-orange"
            >
              Deposit / Withdraw
            </button>
          </div>
        )}
      </div>

      {/* Deposit/Withdraw modal */}
      {showDeposit && <DepositWithdraw onClose={() => setShowDeposit(false)} />}
    </>
  );
}
