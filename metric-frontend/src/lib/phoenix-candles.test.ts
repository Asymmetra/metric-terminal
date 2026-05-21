import { describe, expect, it } from "vitest";
import { normalizeCandle } from "./phoenix-candles";

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
});
