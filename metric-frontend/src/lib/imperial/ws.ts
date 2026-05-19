"use client";

import { IMPERIAL_WS_URL } from "./config";

/**
 * Imperial WebSocket adapters.
 *
 * Two endpoints (both unauthenticated, exempt from rate limits):
 *   GET /ws          — wallet-scoped invalidation signals
 *                       ({type:"positions_updated"} / {type:"orders_updated"})
 *                       Refetch /positions or /orders on each ping.
 *   GET /ws/market   — public market-data stream
 *                       (funding_rate_update / mark_price_update / phoenix_depth_update)
 *
 * Both share the same auto-reconnect skeleton (exponential backoff, max 30s).
 * Built for Phase B; full subscription multiplexing + payload typing land in
 * Phase D when the existing useWebSocket() hook gets rewired.
 */

type Listener = (msg: unknown) => void;

abstract class ImperialWs {
  protected ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectMs = 1000;
  private closed = false;

  constructor(protected path: string) {}

  connect() {
    if (this.closed) return;
    const url = IMPERIAL_WS_URL + this.path;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectMs = 1000;
      this.onOpen();
    };
    ws.onmessage = (e) => this.handleRaw(e.data);
    ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  }

  disconnect() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  ping() {
    this.send({ type: "ping" });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected abstract onOpen(): void;

  private handleRaw(data: unknown) {
    let msg: unknown = data;
    if (typeof data === "string") {
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
    }
    for (const l of this.listeners) l(msg);
  }
}

/** /ws — subscribe to a wallet's position/order invalidation pings. */
export class ImperialWalletWs extends ImperialWs {
  constructor(private wallet: string) {
    super("/ws");
  }
  protected onOpen() {
    this.send({ type: "subscribe", wallet: this.wallet });
  }
}

/** /ws/market — funding/mark/phoenix-depth streams. */
export class ImperialMarketWs extends ImperialWs {
  private wantFunding = false;
  private wantMark = false;
  private wantDepthSymbols: string[] | "all" | null = null;

  constructor() {
    super("/ws/market");
  }

  subscribeFundingRates() {
    this.wantFunding = true;
    this.send({ type: "subscribe_funding_rates" });
  }
  subscribeMarkPrices() {
    this.wantMark = true;
    this.send({ type: "subscribe_mark_prices" });
  }
  subscribePhoenixDepth(symbols?: string[]) {
    this.wantDepthSymbols = symbols && symbols.length ? symbols : "all";
    this.send(
      symbols && symbols.length
        ? { type: "subscribe_phoenix_depth", symbols }
        : { type: "subscribe_phoenix_depth" }
    );
  }

  protected onOpen() {
    // Re-send any subscriptions the caller had pre-registered before reconnect.
    if (this.wantFunding) this.send({ type: "subscribe_funding_rates" });
    if (this.wantMark) this.send({ type: "subscribe_mark_prices" });
    if (this.wantDepthSymbols === "all") {
      this.send({ type: "subscribe_phoenix_depth" });
    } else if (Array.isArray(this.wantDepthSymbols)) {
      this.send({ type: "subscribe_phoenix_depth", symbols: this.wantDepthSymbols });
    }
  }
}
