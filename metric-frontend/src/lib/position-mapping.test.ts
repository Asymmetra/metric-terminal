import { describe, expect, it } from "vitest";
import { venueOf, sideOf } from "./position-mapping";

const pos = (underwriter: string, source = "imperial") => ({ underwriter, source });

describe("venueOf — close-path underwriter resolution", () => {
  it("maps each venue tag Imperial stamps to its VenueTag", () => {
    expect(venueOf(pos("jupiter"))).toBe("jupiter");
    expect(venueOf(pos("phoenix"))).toBe("phoenix");
    expect(venueOf(pos("gmtrade"))).toBe("gmtrade");
    expect(venueOf(pos("flash_trade"))).toBe("flash_trade");
  });
  it("distinguishes flash_v2 from flash_trade (must NOT collapse to code-1)", () => {
    // The load-bearing case: a flash_v2 position must close on FlashV2 (code 4),
    // never on Flash v1 (code 1). Both contain "flash"; only v2 carries the marker.
    expect(venueOf(pos("flash_v2"))).toBe("flash_v2");
    expect(venueOf(pos("flash"))).toBe("flash_trade"); // bare "flash" → v1
  });
  it("is case-insensitive and checks the source field too", () => {
    expect(venueOf(pos("FLASH_V2"))).toBe("flash_v2");
    expect(venueOf({ underwriter: "flash", source: "flash_v2" })).toBe("flash_v2");
  });
  it("falls back to phoenix for an unknown underwriter", () => {
    expect(venueOf(pos("something-new"))).toBe("phoenix");
  });
});

describe("sideOf", () => {
  it("normalizes long/short regardless of case", () => {
    expect(sideOf("Short")).toBe("short");
    expect(sideOf("SHORT")).toBe("short");
    expect(sideOf("long")).toBe("long");
    expect(sideOf("Long")).toBe("long");
    expect(sideOf("")).toBe("long");
  });
});
