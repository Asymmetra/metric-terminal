import { afterEach, describe, expect, it } from "vitest";
import {
  fetch24hStats,
  fetchCandles,
  normalizeCandle,
  PHOENIX_API_URL,
  toMarkLine,
  type Candle,
} from "./phoenix-candles";

describe("normalizeCandle", () => {
  it("converts ms timestamps to seconds for lightweight-charts", () => {
    const c = normalizeCandle({
      time: 1779400860000,
      open: 87.29,
      high: 87.35,
      low: 87.28,
      close: 87.33,
      volume: 1.5,
    });
    expect(c.time).toBe(1779400860);
    expect(c.open).toBe(87.29);
    expect(c.close).toBe(87.33);
    expect(c.volume).toBe(1.5);
  });

  it("leaves second timestamps untouched", () => {
    const c = normalizeCandle({ time: 1779400860, open: 1, high: 1, low: 1, close: 1 });
    expect(c.time).toBe(1779400860);
  });

  it("defaults missing volume to 0", () => {
    const c = normalizeCandle({ time: 1779400860000, open: 1, high: 2, low: 0.5, close: 1.5 });
    expect(c.volume).toBe(0);
  });

  it("falls back markClose to the trade close when the feed omits it", () => {
    const c = normalizeCandle({ time: 1779400860000, open: 1, high: 2, low: 0.5, close: 1.75 });
    expect(c.markClose).toBe(1.75); // markClose ?? close
  });

  it("keeps an explicit markClose when present", () => {
    const c = normalizeCandle({ time: 1779400860000, open: 1, high: 2, low: 0.5, close: 1.75, markClose: 1.8 });
    expect(c.markClose).toBe(1.8);
  });

  it("treats exactly 1e12 as seconds (boundary: > 1e12 is ms)", () => {
    expect(normalizeCandle({ time: 1e12, open: 1, high: 1, low: 1, close: 1 }).time).toBe(1e12);
    expect(normalizeCandle({ time: 1e12 + 1, open: 1, high: 1, low: 1, close: 1 }).time).toBe(Math.floor((1e12 + 1) / 1000));
  });
});

describe("toMarkLine", () => {
  it("maps candles to {time, value:markClose} line points", () => {
    const candles: Candle[] = [
      { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, markClose: 1.4, volume: 0 },
      { time: 160, open: 1.5, high: 2, low: 1, close: 1.8, markClose: 1.7, volume: 0 },
    ];
    expect(toMarkLine(candles)).toEqual([
      { time: 100, value: 1.4 },
      { time: 160, value: 1.7 },
    ]);
  });
  it("maps an empty list to an empty array", () => {
    expect(toMarkLine([])).toEqual([]);
  });
});

describe("fetchCandles", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function capture(body: unknown, ok = true): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
    }) as typeof fetch;
    return { calls };
  }

  it("builds the default URL (limit 300, no before) and normalizes+sorts the rows", async () => {
    const { calls } = capture([
      { time: 1779400920000, open: 2, high: 2, low: 2, close: 2 }, // later, out of order
      { time: 1779400860000, open: 1, high: 1, low: 1, close: 1 }, // earlier
    ]);
    const out = await fetchCandles("SOL", "1m");
    expect(calls[0]).toBe(`${PHOENIX_API_URL}/candles?symbol=SOL&timeframe=1m&limit=300`);
    expect(out.map((c) => c.time)).toEqual([1779400860, 1779400920]); // ascending
  });

  it("appends limit + before when supplied", async () => {
    const { calls } = capture([]);
    await fetchCandles("BTC", "1h", { limit: 50, before: 1779400860000 });
    expect(calls[0]).toBe(`${PHOENIX_API_URL}/candles?symbol=BTC&timeframe=1h&limit=50&before=1779400860000`);
  });

  it("returns [] when the payload is not an array", async () => {
    capture({ unexpected: "shape" });
    expect(await fetchCandles("SOL", "1m")).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    capture([], false);
    await expect(fetchCandles("SOL", "1m")).rejects.toThrow(/Phoenix candles 500/);
  });
});

describe("fetch24hStats", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function capture(body: unknown, ok = true): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
    }) as typeof fetch;
    return { calls };
  }

  it("requests 25 1h candles and derives the 24h headline stats", async () => {
    const rows = [
      { time: 1, open: 100, high: 110, low: 95, close: 105, volumeQuote: 1000 },
      { time: 2, open: 105, high: 120, low: 100, close: 112, volumeQuote: 2000 },
    ];
    const { calls } = capture(rows);
    const s = await fetch24hStats("SOL");
    expect(calls[0]).toBe(`${PHOENIX_API_URL}/candles?symbol=SOL&timeframe=1h&limit=25`);
    expect(s.open24h).toBe(100); // first row open
    expect(s.lastClose).toBe(112); // last row close
    expect(s.high24h).toBe(120);
    expect(s.low24h).toBe(95);
    expect(s.volume24hQuote).toBe(3000);
    expect(s.change24h).toBeCloseTo((112 - 100) / 100, 10); // +12%
  });

  it("returns all-null stats for an empty / non-array payload", async () => {
    capture([]);
    const s = await fetch24hStats("SOL");
    expect(s).toEqual({
      open24h: null,
      high24h: null,
      low24h: null,
      lastClose: null,
      volume24hQuote: 0,
      change24h: null,
    });
  });

  it("uses only the last 24 of >24 rows for the window", async () => {
    // 25 rows: open should come from row index 1 (the last 24), not index 0.
    const rows = Array.from({ length: 25 }, (_, i) => ({
      time: i,
      open: i === 1 ? 200 : 999, // the window's first open is row[1]
      high: 1,
      low: 1,
      close: i === 24 ? 250 : 1,
      volumeQuote: 1,
    }));
    capture(rows);
    const s = await fetch24hStats("SOL");
    expect(s.open24h).toBe(200); // slice(-24)[0]
    expect(s.lastClose).toBe(250);
    expect(s.volume24hQuote).toBe(24); // 24 rows × 1
  });

  it("throws on a non-ok response", async () => {
    capture([], false);
    await expect(fetch24hStats("SOL")).rejects.toThrow(/Phoenix candles 500/);
  });
});
