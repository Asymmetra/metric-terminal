import { describe, expect, it } from "vitest";
import { freshness, overallColor, restColor, wsColor } from "./health";

// All four are pure derivation helpers. `now` is injected everywhere so the age-band
// boundaries are deterministic without touching the real clock.

describe("wsColor (age bands)", () => {
  const NOW = 1_000_000;
  it("is idle when no message has ever arrived", () => {
    expect(wsColor({ lastMessageAt: null }, NOW)).toBe("idle");
  });
  it("is ok when fresh (< 5s)", () => {
    expect(wsColor({ lastMessageAt: NOW }, NOW)).toBe("ok"); // age 0
    expect(wsColor({ lastMessageAt: NOW - 4_999 }, NOW)).toBe("ok"); // just under 5s
  });
  it("is warn between 5s and 20s (stale-but-alive)", () => {
    expect(wsColor({ lastMessageAt: NOW - 5_000 }, NOW)).toBe("warn"); // exactly 5s → warn
    expect(wsColor({ lastMessageAt: NOW - 19_999 }, NOW)).toBe("warn"); // just under 20s
  });
  it("is down at/after 20s", () => {
    expect(wsColor({ lastMessageAt: NOW - 20_000 }, NOW)).toBe("down"); // exactly 20s → down
    expect(wsColor({ lastMessageAt: NOW - 60_000 }, NOW)).toBe("down");
  });
});

describe("restColor (ok / latency / null)", () => {
  it("is idle when ok is null (never probed)", () => {
    expect(restColor({ ok: null, latencyMs: null, detail: null, checkedAt: null })).toBe("idle");
  });
  it("is down when ok is false, regardless of latency", () => {
    expect(restColor({ ok: false, latencyMs: 10, detail: null, checkedAt: 1 })).toBe("down");
    expect(restColor({ ok: false, latencyMs: null, detail: "boom", checkedAt: 1 })).toBe("down");
  });
  it("is ok when up with no latency reported, or snappy latency", () => {
    expect(restColor({ ok: true, latencyMs: null, detail: null, checkedAt: 1 })).toBe("ok");
    expect(restColor({ ok: true, latencyMs: 599, detail: null, checkedAt: 1 })).toBe("ok"); // < 600
  });
  it("warns (never down) on sluggish-but-alive latency", () => {
    expect(restColor({ ok: true, latencyMs: 600, detail: null, checkedAt: 1 })).toBe("warn"); // boundary
    expect(restColor({ ok: true, latencyMs: 1_499, detail: null, checkedAt: 1 })).toBe("warn");
    expect(restColor({ ok: true, latencyMs: 5_000, detail: null, checkedAt: 1 })).toBe("warn"); // slow ≠ down
  });
});

describe("overallColor (worst-wins, ignores idle)", () => {
  it("is idle when there are no live inputs", () => {
    expect(overallColor([])).toBe("idle");
    expect(overallColor(["idle", "idle"])).toBe("idle");
  });
  it("is down only when EVERY live input is down", () => {
    expect(overallColor(["down", "down"])).toBe("down");
    expect(overallColor(["down", "down", "idle"])).toBe("down"); // idle ignored
  });
  it("downgrades a mix of down + non-down to warn (not down)", () => {
    expect(overallColor(["down", "ok"])).toBe("warn");
    expect(overallColor(["down", "warn"])).toBe("warn");
  });
  it("is warn when any live input warns (and none/some down handled above)", () => {
    expect(overallColor(["ok", "warn"])).toBe("warn");
    expect(overallColor(["warn", "idle"])).toBe("warn");
  });
  it("is ok only when every live input is ok", () => {
    expect(overallColor(["ok", "ok"])).toBe("ok");
    expect(overallColor(["ok", "ok", "idle"])).toBe("ok");
  });
});

describe("freshness", () => {
  const NOW = 10_000_000;
  it("renders an em-dash for a null timestamp", () => {
    expect(freshness(null, NOW)).toBe("—");
  });
  it("renders '<1s ago' under one second", () => {
    expect(freshness(NOW, NOW)).toBe("<1s ago"); // 0s
    expect(freshness(NOW - 999, NOW)).toBe("<1s ago"); // 0.999s
  });
  it("renders 'Ns ago' in the seconds band, rounding to nearest second", () => {
    expect(freshness(NOW - 1_000, NOW)).toBe("1s ago"); // boundary
    expect(freshness(NOW - 5_400, NOW)).toBe("5s ago"); // 5.4 → 5
    expect(freshness(NOW - 59_000, NOW)).toBe("59s ago");
  });
  it("renders 'Nm ago' from 60s up, rounding to nearest minute", () => {
    expect(freshness(NOW - 60_000, NOW)).toBe("1m ago"); // boundary
    expect(freshness(NOW - 150_000, NOW)).toBe("3m ago"); // 2.5m → 3
  });
  it("clamps a future timestamp to '<1s ago' (never negative)", () => {
    expect(freshness(NOW + 5_000, NOW)).toBe("<1s ago");
  });
});
