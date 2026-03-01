"use client";

import { useEffect } from "react";
import { wsClient } from "@/lib/ws";
import { api } from "@/lib/api";
import { useMarketStore } from "@/stores/marketStore";
import { useOrderbookStore } from "@/stores/orderbookStore";
import { useTradeStore } from "@/stores/tradeStore";
import { useStatsStore } from "@/stores/statsStore";

export function useWebSocket() {
  const selectedSymbol = useMarketStore((s) => s.selectedSymbol);
  const setMarketConfig = useMarketStore((s) => s.setMarketConfig);
  const setOrderbook = useOrderbookStore((s) => s.setOrderbook);
  const addTrades = useTradeStore((s) => s.addTrades);
  const setTrades = useTradeStore((s) => s.setTrades);
  const setStats = useStatsStore((s) => s.setStats);
  const setMarkPrice = useStatsStore((s) => s.setMarkPrice);

  useEffect(() => {
    // Clear stale data from previous market immediately
    setOrderbook([], []);
    setTrades([]);
    setStats(null);

    const abortController = new AbortController();
    const { signal } = abortController;

    wsClient.connect();

    // Fetch market config (maxLeverage, baseLotsDecimals, tickSize)
    api.getMarket(selectedSymbol, signal)
      .then((data) => {
        setMarketConfig({
          maxLeverage: data.maxLeverage || 10,
          baseLotsDecimals: data.baseLotsDecimals || 2,
          tickSize: data.tickSize || 100,
        });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[REST] Market config fetch failed:", err);
      });

    // Fetch initial orderbook snapshot via REST (immediate data)
    api.getOrderbook(selectedSymbol, signal)
      .then((data) => {
        if (data.bids && data.asks) {
          setOrderbook(data.bids, data.asks);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[REST] Orderbook fetch failed:", err);
      });

    const unsubOrderbook = wsClient.subscribe(
      "orderbook",
      selectedSymbol,
      (data) => {
        if (data.bids && data.asks) {
          setOrderbook(data.bids, data.asks);
        }
      }
    );

    const unsubTrades = wsClient.subscribe(
      "trades",
      selectedSymbol,
      (data) => {
        if (data.trades) {
          addTrades(data.trades);
        }
      }
    );

    const unsubStats = wsClient.subscribe(
      "stats",
      selectedSymbol,
      (data) => {
        setStats(data);
        if (data?.mark_price != null) {
          setMarkPrice(selectedSymbol, data.mark_price);
        }
      }
    );

    return () => {
      abortController.abort();
      unsubOrderbook();
      unsubTrades();
      unsubStats();
    };
  }, [selectedSymbol, setMarketConfig, setOrderbook, addTrades, setTrades, setStats, setMarkPrice]);
}
