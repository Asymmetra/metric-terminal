"use client";

import { useOrderbookStore } from "@/stores/orderbookStore";
import { useStatsStore } from "@/stores/statsStore";

/**
 * Direct connection to Phoenix's public market WebSocket.
 *
 * We subscribe to the `orderbook` channel for one symbol and derive both the
 * order-book snapshot AND the live mid price from it. This bypasses Imperial's
 * relayed `/ws/market` (which has been flaky — when it drops, the chart loses
 * its price feed and drifts), giving the active symbol a reliable ~1.7/sec feed
 * straight from the source.
 *
 * Wire format (verified): { channel:"orderbook", symbol, orderbook:{
 *   bids:[[price,size],…], asks:[[price,size],…], mid } }.
 */

const PHOENIX_WS_URL =
  process.env.NEXT_PUBLIC_PHOENIX_WS_URL ?? "wss://perp-api.phoenix.trade/ws";

export class PhoenixSymbolFeed {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectMs = 1000;

  constructor(
    private readonly symbol: string,
    private readonly onTick?: () => void
  ) {}

  start() {
    if (this.closed) return;
    const ws = new WebSocket(PHOENIX_WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectMs = 1000;
      ws.send(
        JSON.stringify({ type: "subscribe", subscription: { channel: "orderbook", symbol: this.symbol } })
      );
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.start(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 15_000);
    };
    ws.onerror = () => ws.close();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private onMessage(data: unknown) {
    let m: {
      channel?: string;
      symbol?: string;
      orderbook?: { bids?: [number, number][]; asks?: [number, number][]; mid?: number };
    };
    try {
      m = typeof data === "string" ? JSON.parse(data) : (data as never);
    } catch {
      return;
    }
    if (m.channel !== "orderbook" || m.symbol !== this.symbol || !m.orderbook) return;

    const ob = m.orderbook;
    const bids = (ob.bids ?? []).map(([price, size]) => ({ price, size }));
    const asks = (ob.asks ?? []).map(([price, size]) => ({ price, size }));
    const mid =
      typeof ob.mid === "number"
        ? ob.mid
        : bids[0] && asks[0]
        ? (bids[0].price + asks[0].price) / 2
        : undefined;

    if (typeof mid === "number") {
      useStatsStore.getState().setVenueMark(this.symbol, "phoenix", mid);
    }
    useOrderbookStore.getState().setSnapshot({ symbol: this.symbol, mid: mid ?? 0, bids, asks });
    this.onTick?.();
  }
}
