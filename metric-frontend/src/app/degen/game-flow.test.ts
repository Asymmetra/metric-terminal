import { describe, expect, it, vi } from "vitest";
import {
  GAME_LEVERAGE,
  GAME_PROFILE,
  MIN_STAKE_USD,
  WINDOW_MS,
  CLOSE_ORDER_RETRIES,
  sizeForStake,
  validateStake,
  initialDeadline,
  extendDeadline,
  remainingMs,
  formatCountdown,
  findGamePosition,
  num,
  isRetryableCloseError,
  placeCloseWithRetry,
} from "./game-flow";
import { isRetryableOrderError, isTransientResolveError } from "@/lib/trade-flow";
import type { OrderResponse, PositionLifecycle } from "@/lib/imperial/types";

describe("sizeForStake", () => {
  it("applies the fixed 400x leverage", () => {
    expect(sizeForStake(10)).toBe(10 * GAME_LEVERAGE);
    expect(sizeForStake(25)).toBe(25 * GAME_LEVERAGE);
  });
  it("rounds to 2 decimals (avoids float dust in the size)", () => {
    // 10.005 * 400 = 4002.0000000001 in float → must round clean to 4002
    expect(sizeForStake(10.005)).toBe(4002);
    expect(sizeForStake(12.34)).toBe(4936);
  });
});

describe("num", () => {
  it("parses numeric strings, defaulting null/undefined/garbage to 0", () => {
    expect(num("4000")).toBe(4000);
    expect(num("12.5")).toBe(12.5);
    expect(num("-3")).toBe(-3);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("not-a-number")).toBe(0);
    expect(num("")).toBe(0);
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
  it("treats a null profileIndex as in-profile (some sources omit it)", () => {
    expect(findGamePosition([row({ profileIndex: null as unknown as number })])?.asset).toBe("SOL");
  });
  it("rejects a position in a DIFFERENT profile (never adopts /terminal positions)", () => {
    expect(findGamePosition([row({ profileIndex: (GAME_PROFILE - 1) as number })])).toBeUndefined();
    expect(findGamePosition([row({ profileIndex: 0 })])).toBeUndefined();
  });
  it("treats a positive size as open even if status isn't the literal 'open'", () => {
    // The indexer sometimes reports status 'filled'/null but a nonzero size — still our live bet.
    expect(findGamePosition([row({ status: "filled", sizeUsd: "4000" })])?.asset).toBe("SOL");
    expect(findGamePosition([row({ status: undefined as unknown as string, sizeUsd: "4000" })])?.asset).toBe("SOL");
  });
  it("matches flash_v2 case-insensitively across underwriter/source", () => {
    expect(findGamePosition([row({ underwriter: "FLASH", source: "V2" })])?.asset).toBe("SOL");
    expect(findGamePosition([row({ underwriter: "Flash_V2", source: "imperial" })])?.asset).toBe("SOL");
  });
  it("returns the FIRST matching game row when several positions exist", () => {
    const other = row({ asset: "BTC" });
    const ours = row({ sizeUsd: "8000" });
    expect(findGamePosition([other, ours])).toBe(ours);
  });
  it("returns undefined for an empty list", () => {
    expect(findGamePosition([])).toBeUndefined();
  });
});

describe("isRetryableCloseError", () => {
  it("retries transient placement bounces (the reported auto-close loop trigger)", () => {
    expect(isRetryableCloseError("Failed to place order — please try again.")).toBe(true);
    expect(isRetryableCloseError("please try again")).toBe(true);
    expect(isRetryableCloseError("request timed out")).toBe(true);
    expect(isRetryableCloseError("service unavailable (503)")).toBe(true);
    expect(isRetryableCloseError("too many requests")).toBe(true);
  });
  it("retries a cold-cache symbol-resolution miss", () => {
    expect(isRetryableCloseError('could not resolve symbol "SOL" for underwriter 4')).toBe(true);
    expect(isRetryableCloseError("check that the venue lists this market")).toBe(true);
  });
  it("does NOT retry hard rejections or empty errors (no infinite loop)", () => {
    expect(isRetryableCloseError("no position to close")).toBe(false);
    expect(isRetryableCloseError("insufficient margin")).toBe(false);
    expect(isRetryableCloseError("max leverage exceeded")).toBe(false);
    expect(isRetryableCloseError(null)).toBe(false);
    expect(isRetryableCloseError(undefined)).toBe(false);
    expect(isRetryableCloseError("")).toBe(false);
  });

  it("is EXACTLY the union of the open path's two classifiers (anti-drift guard)", () => {
    // The close retry policy must never diverge from the open one. If someone later
    // tweaks isRetryableOrderError / isTransientResolveError, this catches the drift.
    const samples = [
      "Failed to place order — please try again.",
      "please try again",
      "request timed out",
      "service unavailable (503)",
      "too many requests",
      'could not resolve symbol "SOL" for underwriter 4',
      "check that the venue lists this market",
      "no position to close",
      "insufficient margin",
      "max leverage exceeded",
      "route too large",
      "",
      null,
      undefined,
    ];
    for (const s of samples) {
      expect(isRetryableCloseError(s)).toBe(isTransientResolveError(s) || isRetryableOrderError(s));
    }
  });
});

describe("placeCloseWithRetry", () => {
  const OK: OrderResponse = { success: true, signature: "sig", orderPda: null, error: null };
  const fail = (error: string): OrderResponse => ({ success: false, signature: null, orderPda: null, error });
  const noSleep = async () => {};

  it("returns immediately on a first-attempt success (one placement)", async () => {
    const place = vi.fn(async () => OK);
    const res = await placeCloseWithRetry(place, { sleep: noSleep });
    expect(res.success).toBe(true);
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 'please try again' bounce, then fills — THE BUG FIX", async () => {
    // This is exactly the user's report: the close kept bouncing with a retryable
    // error. The old code retried only on resolve-misses, so it looped. Now it fills.
    let n = 0;
    const place = vi.fn(async () => (++n < 3 ? fail("Failed to place order — please try again.") : OK));
    const onRetry = vi.fn();
    const res = await placeCloseWithRetry(place, { sleep: noSleep, onRetry });
    expect(res.success).toBe(true);
    expect(place).toHaveBeenCalledTimes(3); // bounced twice, filled on the third
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, CLOSE_ORDER_RETRIES);
  });

  it("retries a cold-cache resolve miss on close too", async () => {
    let n = 0;
    const place = vi.fn(async () => (++n < 2 ? fail('could not resolve symbol "SOL" for underwriter 4') : OK));
    const res = await placeCloseWithRetry(place, { sleep: noSleep });
    expect(res.success).toBe(true);
    expect(place).toHaveBeenCalledTimes(2);
  });

  it("stops IMMEDIATELY on a hard rejection — does not burn retries or loop", async () => {
    const place = vi.fn(async () => fail("no position to close"));
    const onRetry = vi.fn();
    const res = await placeCloseWithRetry(place, { sleep: noSleep, onRetry });
    expect(res.success).toBe(false);
    expect(res.error).toBe("no position to close");
    expect(place).toHaveBeenCalledTimes(1); // no pointless retries on a terminal error
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("gives up after exactly `retries` attempts on a persistent transient failure", async () => {
    const place = vi.fn(async () => fail("please try again"));
    const res = await placeCloseWithRetry(place, { sleep: noSleep, retries: 4 });
    expect(res.success).toBe(false);
    expect(place).toHaveBeenCalledTimes(4); // initial + 3 retries, then surfaces the failure
  });

  it("defaults to CLOSE_ORDER_RETRIES total attempts", async () => {
    const place = vi.fn(async () => fail("please try again"));
    await placeCloseWithRetry(place, { sleep: noSleep });
    expect(place).toHaveBeenCalledTimes(CLOSE_ORDER_RETRIES);
  });

  it("clamps a retries value below 1 to a single attempt", async () => {
    const place = vi.fn(async () => fail("please try again"));
    await placeCloseWithRetry(place, { sleep: noSleep, retries: 0 });
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("waits retryMs between attempts (sleeper invoked with the configured delay)", async () => {
    let n = 0;
    const place = vi.fn(async () => (++n < 2 ? fail("please try again") : OK));
    const sleep = vi.fn(async () => {});
    await placeCloseWithRetry(place, { sleep, retryMs: 800, retries: 3 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(800);
  });

  it("does NOT sleep after the final failed attempt (no trailing delay)", async () => {
    const place = vi.fn(async () => fail("please try again"));
    const sleep = vi.fn(async () => {});
    await placeCloseWithRetry(place, { sleep, retries: 3 });
    // 3 attempts → only 2 inter-attempt sleeps, none after the last.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
