/**
 * Phoenix public market-data candles.
 *
 * Imperial has no OHLC endpoint, so the chart sources candlesticks directly
 * from Phoenix's public market-data API — the same feed Imperial's own
 * dashboard renders ("SOL/USD · Phoenix"). Read-only; trades still route
 * through Imperial. Only Phoenix-listed perps return data here.
 *
 * Endpoint (verified live):
 *   GET https://perp-api.phoenix.trade/candles?symbol=SOL&timeframe=1m&limit=300[&before=<ms>]
 *   → [{ time(ms), open, high, low, close, markOpen, markHigh, markLow,
 *        markClose, volume, volumeQuote, tradeCount }, ...] ascending by time
 */

export const PHOENIX_API_URL =
  process.env.NEXT_PUBLIC_PHOENIX_API_URL ?? "https://perp-api.phoenix.trade";

/** Timeframes Phoenix accepts and the chart exposes. */
export const TIMEFRAMES = [
  { label: "1m", value: "1m", seconds: 60 },
  { label: "5m", value: "5m", seconds: 300 },
  { label: "15m", value: "15m", seconds: 900 },
  { label: "1H", value: "1h", seconds: 3600 },
  { label: "4H", value: "4h", seconds: 14400 },
  { label: "1D", value: "1d", seconds: 86400 },
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number]["value"];

/** Candle in lightweight-charts shape — `time` is **unix seconds**. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Mark-price close for this bucket (Phoenix `markClose`). Falls back to
   *  the trade close when the feed omits it. Used for the mark-based line. */
  markClose: number;
  volume: number;
}

interface PhoenixCandleRaw {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  markClose?: number;
  volume?: number;
  volumeQuote?: number;
  tradeCount?: number;
}

/** Normalize a raw Phoenix candle: ms→seconds, default volume. */
export function normalizeCandle(c: PhoenixCandleRaw): Candle {
  const time = c.time > 1e12 ? Math.floor(c.time / 1000) : c.time;
  return {
    time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    markClose: c.markClose ?? c.close,
    volume: c.volume ?? 0,
  };
}

/** Map candles to mark-based line points ({time, value: markClose}). */
export function toMarkLine(candles: Candle[]): { time: number; value: number }[] {
  return candles.map((c) => ({ time: c.time, value: c.markClose }));
}

/**
 * Fetch a page of candles for `symbol`. Pass `before` (unix ms) to page
 * backward through history (the upper bound is exclusive). Returns candles
 * ascending by time, deduped and sorted.
 */
export async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  opts: { limit?: number; before?: number; signal?: AbortSignal } = {}
): Promise<Candle[]> {
  const qs = new URLSearchParams({
    symbol,
    timeframe,
    limit: String(opts.limit ?? 300),
  });
  if (opts.before) qs.set("before", String(opts.before));

  const res = await fetch(`${PHOENIX_API_URL}/candles?${qs.toString()}`, {
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`Phoenix candles ${res.status}`);
  }
  const raw = (await res.json()) as PhoenixCandleRaw[];
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCandle).sort((a, b) => a.time - b.time);
}

export interface DayStats {
  open24h: number | null;
  high24h: number | null;
  low24h: number | null;
  lastClose: number | null;
  /** Quote-volume summed over the last 24h of 1h candles. */
  volume24hQuote: number;
  /** Fractional change vs 24h ago, e.g. 0.016 = +1.6%. */
  change24h: number | null;
}

/**
 * Derive 24h header stats from 1h Phoenix candles. Cheap (24 rows) and
 * matches what the perp dashboards show.
 */
export async function fetch24hStats(
  symbol: string,
  signal?: AbortSignal
): Promise<DayStats> {
  const qs = new URLSearchParams({ symbol, timeframe: "1h", limit: "25" });
  const res = await fetch(`${PHOENIX_API_URL}/candles?${qs.toString()}`, { signal });
  if (!res.ok) throw new Error(`Phoenix candles ${res.status}`);
  const raw = (await res.json()) as (PhoenixCandleRaw & { volumeQuote?: number })[];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { open24h: null, high24h: null, low24h: null, lastClose: null, volume24hQuote: 0, change24h: null };
  }
  const rows = raw.slice(-24);
  const open24h = rows[0].open;
  const lastClose = rows[rows.length - 1].close;
  const high24h = Math.max(...rows.map((r) => r.high));
  const low24h = Math.min(...rows.map((r) => r.low));
  const volume24hQuote = rows.reduce((a, r) => a + (r.volumeQuote ?? 0), 0);
  const change24h = open24h ? (lastClose - open24h) / open24h : null;
  return { open24h, high24h, low24h, lastClose, volume24hQuote, change24h };
}
