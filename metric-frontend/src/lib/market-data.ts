"use client";

/**
 * Market-data controller: one Imperial `/ws/market` connection feeding the
 * zustand stores (marks, funding, order book) for the whole terminal.
 *
 * - REST `getMarkPrices()` seeds the symbol list + initial marks on start.
 * - WS `mark_price_update` / `funding_rate_update` keep marks + funding live.
 * - WS `phoenix_depth_update` feeds the order book for the selected symbol
 *   (Phoenix-venue only; AMM venues have no book).
 *
 * Ref-counted: the Terminal calls start()/stop() on mount/unmount.
 */

import { imperial } from "@/lib/imperial";
import { ImperialMarketWs } from "@/lib/imperial/ws";
import { useMarketStore, type MarketInfo } from "@/stores/marketStore";
import { useStatsStore } from "@/stores/statsStore";
import { useOrderbookStore } from "@/stores/orderbookStore";
import type { MarkPriceRow } from "@/lib/imperial/types";

interface MarkPriceMsg {
  type: "mark_price_update";
  symbol: string;
  venue: string;
  price: number;
  fetched_at_unix_ms: number;
}
interface FundingMsg {
  type: "funding_rate_update";
  symbol: string;
  venue: string;
  long_funding_rate_per_hour_percent: number | null;
  short_funding_rate_per_hour_percent: number | null;
}
interface DepthMsg {
  type: "phoenix_depth_update";
  symbol: string;
  snapshot: {
    symbol: string;
    mid: number;
    bids: { price: number; sizeBase: number }[];
    asks: { price: number; sizeBase: number }[];
  };
}

function venuesOf(row: MarkPriceRow): string[] {
  const out: string[] = [];
  if (row.phoenix) out.push("phoenix");
  if (row.jupiter) out.push("jupiter");
  if (row.flash) out.push("flash");
  if (row.gmtrade) out.push("gmtrade");
  return out;
}

class MarketDataController {
  private ws: ImperialMarketWs | null = null;
  private refcount = 0;
  private depthSymbol: string | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastMsgAt = 0;

  start() {
    this.refcount += 1;
    if (this.ws) return;

    void this.hydrateSymbols();

    const ws = new ImperialMarketWs();
    this.ws = ws;
    ws.on((raw) => this.onMessage(raw));
    ws.connect();
    ws.subscribeMarkPrices();
    ws.subscribeFundingRates();
    if (this.depthSymbol) ws.subscribePhoenixDepth([this.depthSymbol]);

    // Connection liveness: marks "connected" off the message heartbeat.
    this.staleTimer = setInterval(() => {
      const alive = Date.now() - this.lastMsgAt < 10_000;
      if (useMarketStore.getState().connected !== alive) {
        useMarketStore.getState().setConnected(alive);
      }
    }, 2_000);
  }

  stop() {
    this.refcount = Math.max(0, this.refcount - 1);
    if (this.refcount > 0) return;
    this.ws?.disconnect();
    this.ws = null;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    useMarketStore.getState().setConnected(false);
  }

  /** (Re)point the Phoenix depth subscription at a symbol. */
  setDepthSymbol(symbol: string) {
    if (this.depthSymbol === symbol) return;
    this.depthSymbol = symbol;
    useOrderbookStore.getState().setSnapshot(null);
    this.ws?.subscribePhoenixDepth([symbol]);
  }

  private async hydrateSymbols() {
    try {
      const { rows } = await imperial.getMarkPrices();
      const markets: MarketInfo[] = rows
        .map((r) => ({ symbol: r.symbol, venues: venuesOf(r), phoenix: !!r.phoenix }))
        .filter((m) => m.venues.length > 0)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      useMarketStore.getState().setMarkets(markets);

      const setMark = useStatsStore.getState().setMark;
      for (const r of rows) {
        const px = r.phoenix?.price ?? r.jupiter?.price ?? r.flash?.price ?? r.gmtrade?.price;
        if (typeof px === "number") setMark(r.symbol, px);
      }
    } catch {
      // WS will populate marks shortly; symbol list stays empty until then.
    }
  }

  private onMessage(raw: unknown) {
    this.lastMsgAt = Date.now();
    const msg = raw as { type?: string };
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "mark_price_update") {
      const m = msg as MarkPriceMsg;
      if (typeof m.price === "number") useStatsStore.getState().setMark(m.symbol, m.price);
      return;
    }
    if (msg.type === "funding_rate_update") {
      const m = msg as FundingMsg;
      useStatsStore.getState().setFunding(m.symbol, {
        longPerHourPct: m.long_funding_rate_per_hour_percent,
        shortPerHourPct: m.short_funding_rate_per_hour_percent,
        venue: m.venue,
      });
      return;
    }
    if (msg.type === "phoenix_depth_update") {
      const m = msg as DepthMsg;
      if (m.symbol !== this.depthSymbol) return;
      const s = m.snapshot;
      useOrderbookStore.getState().setSnapshot({
        symbol: s.symbol,
        mid: s.mid,
        bids: (s.bids ?? []).map((l) => ({ price: l.price, size: l.sizeBase })),
        asks: (s.asks ?? []).map((l) => ({ price: l.price, size: l.sizeBase })),
      });
    }
  }
}

export const marketData = new MarketDataController();
