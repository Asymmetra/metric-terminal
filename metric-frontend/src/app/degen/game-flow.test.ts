import { describe, expect, it } from "vitest";
import {
  GAME_LEVERAGE,
  MIN_STAKE_USD,
  WINDOW_MS,
  sizeForStake,
  validateStake,
  initialDeadline,
  extendDeadline,
  remainingMs,
  formatCountdown,
  findGamePosition,
} from "./game-flow";
import type { PositionLifecycle } from "@/lib/imperial/types";

describe("sizeForStake", () => {
  it("applies the fixed 400x leverage", () => {
    expect(sizeForStake(10)).toBe(10 * GAME_LEVERAGE);
    expect(sizeForStake(25)).toBe(25 * GAME_LEVERAGE);
  });
});

describe("validateStake", () => {
  it("accepts >= $10", () => {
    expect(validateStake(10)).toBeNull();
    expect(validateStake(50)).toBeNull();
  });
  it("rejects below the minimum and non-positive", () => {
    expect(validateStake(9.99)).toMatch(/Minimum stake is \$10/);
    expect(validateStake(0)).toMatch(/Enter a stake/);
    expect(validateStake(NaN)).toMatch(/Enter a stake/);
  });
  it("MIN_STAKE_USD is Imperial's $10 floor", () => {
    expect(MIN_STAKE_USD).toBe(10);
  });
});

describe("deadline math", () => {
  it("initial deadline is fill time + one 60s window", () => {
    expect(initialDeadline(1_000_000)).toBe(1_000_000 + WINDOW_MS);
  });
  it("double-down extends the END by 60s, not now+60s", () => {
    // Window opened at t=0 → deadline 60_000. At t=30_000 the user doubles down.
    const deadline = initialDeadline(0); // 60_000
    const extended = extendDeadline(deadline); // must be 120_000, NOT 30_000+60_000=90_000
    expect(extended).toBe(120_000);
  });
  it("stacks across multiple double-downs", () => {
    let d = initialDeadline(0);
    d = extendDeadline(d);
    d = extendDeadline(d);
    expect(d).toBe(3 * WINDOW_MS);
  });
  it("remainingMs never goes negative", () => {
    expect(remainingMs(100, 40)).toBe(60);
    expect(remainingMs(100, 250)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("renders m:ss, rounding up partial seconds", () => {
    expect(formatCountdown(60_000)).toBe("1:00");
    expect(formatCountdown(59_400)).toBe("1:00"); // ceil
    expect(formatCountdown(5_000)).toBe("0:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(125_000)).toBe("2:05");
  });
});

describe("findGamePosition", () => {
  const row = (over: Partial<PositionLifecycle>): PositionLifecycle =>
    ({ asset: "SOL", underwriter: "flash_v2", source: "imperial", status: "open", sizeUsd: "4000", profileIndex: 5, ...over } as PositionLifecycle);

  it("finds an open SOL flash_v2 position in the game profile", () => {
    expect(findGamePosition([row({})])?.asset).toBe("SOL");
  });
  it("ignores non-v2 flash and other venues/assets", () => {
    expect(findGamePosition([row({ underwriter: "flash_trade" })])).toBeUndefined();
    expect(findGamePosition([row({ underwriter: "gmtrade" })])).toBeUndefined();
    expect(findGamePosition([row({ asset: "BTC" })])).toBeUndefined();
  });
  it("ignores a closed/zero-size row", () => {
    expect(findGamePosition([row({ status: "closed", sizeUsd: "0" })])).toBeUndefined();
  });
});
