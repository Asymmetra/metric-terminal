import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImperialClient, ImperialError } from "./client";
import { clearJwt, loadJwt, saveJwt } from "./jwt";
import { Action, OrderType, Side, Underwriter } from "./types";

const FAKE_WALLET = "Wallet1111111111111111111111111111111111111";

function fetchMockSuccess(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function fetchMockFail(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("Imperial DTO enums", () => {
  it("exposes the documented numeric tags", () => {
    expect(Underwriter.Jupiter).toBe(0);
    expect(Underwriter.FlashTrade).toBe(1);
    expect(Underwriter.Phoenix).toBe(2);
    expect(Underwriter.GMTrade).toBe(3);
    expect(Underwriter.FlashV2).toBe(4); // FlashTradeV2 (passthrough_client from_u8 rejects >=5)
    expect(Side.Long).toBe(0);
    expect(Side.Short).toBe(1);
    expect(Action.Increase).toBe(0);
    expect(Action.Decrease).toBe(1);
    expect(OrderType.Market).toBe(0);
    expect(OrderType.Limit).toBe(1);
    expect(OrderType.StopLimit).toBe(2);
  });
});

describe("JWT cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves and loads a non-expired token", () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    saveJwt(FAKE_WALLET, "jwt-token", future);
    expect(loadJwt(FAKE_WALLET)).toBe("jwt-token");
  });

  it("evicts an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    saveJwt(FAKE_WALLET, "stale", past);
    expect(loadJwt(FAKE_WALLET)).toBeNull();
  });

  it("evicts a token within the 60s expiry guard", () => {
    // 30 seconds in the future — inside the guard window.
    const soon = Math.floor(Date.now() / 1000) + 30;
    saveJwt(FAKE_WALLET, "almost-stale", soon);
    expect(loadJwt(FAKE_WALLET)).toBeNull();
  });

  it("clearJwt removes the entry", () => {
    saveJwt(FAKE_WALLET, "x", Math.floor(Date.now() / 1000) + 600);
    clearJwt(FAKE_WALLET);
    expect(loadJwt(FAKE_WALLET)).toBeNull();
  });
});

describe("ImperialClient", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
  });

  it("attaches Bearer auth on /mobile/balances", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ wallet: FAKE_WALLET, profiles: [] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const client = new ImperialClient();
    const res = await client.getBalances("jwt-abc");
    expect(res.wallet).toBe(FAKE_WALLET);
    expect(calls).toHaveLength(1);
    const hdrs = calls[0]!.init?.headers as Record<string, string>;
    expect(hdrs.authorization).toBe("Bearer jwt-abc");
  });

  it("getMarkPrices passes no auth header", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new ImperialClient();
    await client.getMarkPrices();
    const hdrs = (calls[0]!.init?.headers as Record<string, string>) ?? {};
    expect(hdrs.authorization).toBeUndefined();
  });

  it("surfaces ImperialError on non-2xx with body.error", async () => {
    globalThis.fetch = fetchMockFail(401, { error: "missing JWT" });
    const client = new ImperialClient();
    await expect(client.getBalances("nope")).rejects.toThrowError(
      ImperialError
    );
  });

  it("buildDepositTx returns the partially-signed base64 tx", async () => {
    globalThis.fetch = fetchMockSuccess({ transaction: "BASE64DEADBEEF" });
    const client = new ImperialClient();
    const res = await client.buildDepositTx({
      wallet: FAKE_WALLET,
      profileIndex: 0,
      amount: 1_000_000,
      mode: "deposit",
    });
    expect(res.transaction).toBe("BASE64DEADBEEF");
  });

  it("connect/exchange path signs and caches the JWT", async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url, body });
      if (url.endsWith("/mobile/connect")) {
        return new Response(JSON.stringify({ code: "one-time-code" }), { status: 200 });
      }
      if (url.endsWith("/mobile/exchange")) {
        return new Response(
          JSON.stringify({
            jwt: "fresh-jwt",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const signer = {
      publicKey: FAKE_WALLET,
      isReady: true,
      displayName: "Mock",
      async signMessage(_msg: string) {
        return { signatureBase58: "FAKESIG" };
      },
      async signAndSendTransaction() {
        throw new Error("not used");
      },
    };

    const client = new ImperialClient();
    const { jwt, expiresAt } = await client.connect(signer);
    expect(jwt).toBe("fresh-jwt");
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Connect request body must include wallet + signed message + signature.
    const connectCall = calls.find((c) => c.url.endsWith("/mobile/connect"))!;
    expect(connectCall.body).toMatchObject({
      wallet: FAKE_WALLET,
      signature: "FAKESIG",
    });
    expect(String((connectCall.body as { message: string }).message)).toContain(
      `imperial:mobile-connect:${FAKE_WALLET}:`
    );

    // JWT should be cached for the wallet now.
    expect(loadJwt(FAKE_WALLET)).toBe("fresh-jwt");
  });
});
