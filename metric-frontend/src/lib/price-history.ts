"use client";

/**
 * Session price-history buffer.
 *
 * A module-level (singleton) per-symbol ring buffer of {t, v} samples covering
 * up to the last hour — our longest live-line window. It's fed continuously by
 * the market-data feed while the terminal is open (independent of which chart
 * view is showing), so:
 *   - switching the line's timeframe just re-windows existing data (no reset),
 *   - the candle view "fills the line in the background",
 *   - and it survives component unmounts within the SPA session.
 *
 * Persisted to localStorage so a reload restores recent context; entries older
 * than 1h (and symbols untouched for >1h) are dropped on load.
 *
 * NOT historical backfill — only what this browser session actually streamed.
 */

export interface PricePoint {
  /** unix seconds */
  t: number;
  v: number;
}

const MAX_AGE_SEC = 3660; // 1h + 1min slack
const MIN_GAP_MS = 200; // throttle: at most ~5 samples/sec per symbol
const MAX_POINTS = 20000; // hard cap per symbol (≈ 1h at 5/s)
const STORAGE_KEY = "metric:price-history:v1";
const SAVE_DEBOUNCE_MS = 5000;

type Listener = () => void;

export class PriceHistory {
  private buf = new Map<string, PricePoint[]>();
  private lastRecordMs = new Map<string, number>();
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  /** Append a sample for `symbol` (throttled), trimming to the 1h window. */
  record(symbol: string, value: number) {
    if (!(value > 0)) return;
    const nowMs = Date.now();
    const last = this.lastRecordMs.get(symbol) ?? 0;
    if (nowMs - last < MIN_GAP_MS) return;
    this.lastRecordMs.set(symbol, nowMs);

    const t = nowMs / 1000;
    const arr = this.buf.get(symbol) ?? [];
    arr.push({ t, v: value });
    const cutoff = t - MAX_AGE_SEC;
    let trimmed = arr.length > MAX_POINTS || arr[0].t < cutoff ? arr.filter((p) => p.t >= cutoff) : arr;
    if (trimmed.length > MAX_POINTS) trimmed = trimmed.slice(-MAX_POINTS);
    this.buf.set(symbol, trimmed);

    this.emit();
    this.scheduleSave();
  }

  /** Points for `symbol` with t >= sinceSec, ascending. */
  getSince(symbol: string, sinceSec: number): PricePoint[] {
    const arr = this.buf.get(symbol);
    if (!arr || arr.length === 0) return [];
    // arr is ascending; find first index >= sinceSec
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t < sinceSec) lo = mid + 1;
      else hi = mid;
    }
    return arr.slice(lo);
  }

  latest(symbol: string): number | undefined {
    const arr = this.buf.get(symbol);
    return arr && arr.length ? arr[arr.length - 1].v : undefined;
  }

  count(symbol: string): number {
    return this.buf.get(symbol)?.length ?? 0;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  // ───────────────────────────── persistence

  /** Load persisted buffers (called lazily on first access in the browser). */
  load() {
    if (this.loaded || typeof window === "undefined") return;
    this.loaded = true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, PricePoint[]>;
      const cutoff = Date.now() / 1000 - MAX_AGE_SEC;
      for (const [symbol, arr] of Object.entries(parsed)) {
        if (!Array.isArray(arr)) continue;
        const fresh = arr.filter((p) => p && typeof p.t === "number" && p.t >= cutoff);
        if (fresh.length) this.buf.set(symbol, fresh);
      }
      if (this.buf.size) this.emit();
    } catch {
      /* corrupt / quota — ignore */
    }
  }

  private scheduleSave() {
    if (typeof window === "undefined" || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  save() {
    if (typeof window === "undefined") return;
    try {
      const cutoff = Date.now() / 1000 - MAX_AGE_SEC;
      const out: Record<string, PricePoint[]> = {};
      for (const [symbol, arr] of this.buf) {
        const fresh = arr.filter((p) => p.t >= cutoff);
        if (fresh.length) out[symbol] = fresh;
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      /* quota exceeded — drop silently */
    }
  }
}

export const priceHistory = new PriceHistory();

if (typeof window !== "undefined") {
  priceHistory.load();
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") priceHistory.save();
  });
  window.addEventListener("pagehide", () => priceHistory.save());
}
