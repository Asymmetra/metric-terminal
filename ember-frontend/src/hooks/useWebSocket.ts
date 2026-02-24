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
  const setStats = useStatsStore((s) => s.setStats);

  useEffect(() => {
    wsClient.connect();

    // Fetch market config (maxLeverage, baseLotsDecimals, tickSize)
    api.getMarket(selectedSymbol)
      .then((data) => {
        setMarketConfig({
          maxLeverage: data.maxLeverage || 10,
          baseLotsDecimals: data.baseLotsDecimals || 2,
          tickSize: data.tickSize || 100,
        });
      })
      .catch((err) => console.error("[REST] Market config fetch failed:", err));

    // Fetch initial orderbook snapshot via REST (immediate data)
    api.getOrderbook(selectedSymbol)
      .then((data) => {
        if (data.bids && data.asks) {
          setOrderbook(data.bids, data.asks);
        }
      })
      .catch((err) => console.error("[REST] Orderbook fetch failed:", err));

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
      }
    );

    return () => {
      unsubOrderbook();
      unsubTrades();
      unsubStats();
    };
  }, [selectedSymbol, setMarketConfig, setOrderbook, addTrades, setStats]);
}
