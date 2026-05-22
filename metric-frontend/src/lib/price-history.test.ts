import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PriceHistory } from "./price-history";

describe("PriceHistory", () => {
  let nowMs = 1_000_000_000_000;
  beforeEach(() => {
    nowMs = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });
  afterEach(() => vi.restoreAllMocks());

  const advance = (ms: number) => {
    nowMs += ms;
  };

  it("records samples and returns them via getSince", () => {
    const h = new PriceHistory();
    h.record("SOL", 100);
    advance(300);
    h.record("SOL", 101);
    advance(300);
    h.record("SOL", 102);
    const all = h.getSince("SOL", 0);
    expect(all.map((p) => p.v)).toEqual([100, 101, 102]);
    expect(h.latest("SOL")).toBe(102);
    expect(h.count("SOL")).toBe(3);
  });

  it("throttles records within MIN_GAP_MS", () => {
    const h = new PriceHistory();
    h.record("SOL", 100);
    advance(50); // < 200ms gap
    h.record("SOL", 999); // dropped
    expect(h.count("SOL")).toBe(1);
    expect(h.latest("SOL")).toBe(100);
  });

  it("ignores non-positive values", () => {
    const h = new PriceHistory();
    h.record("SOL", 0);
    h.record("SOL", -5);
    expect(h.count("SOL")).toBe(0);
  });

  it("getSince filters by time (ascending, binary-searched)", () => {
    const h = new PriceHistory();
    h.record("SOL", 1); // t0
    advance(1000);
    h.record("SOL", 2); // t0+1s
    advance(1000);
    h.record("SOL", 3); // t0+2s
    const sinceSec = Date.now() / 1000 - 1.5; // last ~1.5s → should include 2 and 3
    expect(h.getSince("SOL", sinceSec).map((p) => p.v)).toEqual([2, 3]);
  });

  it("trims samples older than the 1h window", () => {
    const h = new PriceHistory();
    h.record("SOL", 1); // oldest
    advance(3_700_000); // > 1h later
    h.record("SOL", 2);
    const all = h.getSince("SOL", 0);
    expect(all.map((p) => p.v)).toEqual([2]); // old one trimmed
  });

  it("keeps symbols independent", () => {
    const h = new PriceHistory();
    h.record("SOL", 100);
    advance(300);
    h.record("BTC", 50000);
    expect(h.latest("SOL")).toBe(100);
    expect(h.latest("BTC")).toBe(50000);
    expect(h.getSince("ETH", 0)).toEqual([]);
  });
});
