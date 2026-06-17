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

describe("ImperialClient stats + history reads", () => {
  const originalFetch = globalThis.fetch;
  const BASE = "https://api.imperial.space/api/v1";
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Capture the requested URL and return `body` as a 200 JSON response. */
  function captureFetch(body: unknown): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { calls };
  }

  it("getPnlHistory builds the exact query and parses the typed shape", async () => {
    const point = {
      timestamp: 1_700_000_000,
      cumulativePnl: 12.5,
      cumulativeTakerFee: 0.4,
      cumulativeFundingPayment: -0.1,
      unrealizedPnl: null,
    };
    const { calls } = captureFetch([point]);

    const client = new ImperialClient();
    const rows = await client.getPnlHistory(FAKE_WALLET, "1h", {
      since: 100,
      until: 200,
      underwriter: "phoenix",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `${BASE}/pnl-history?walletAddress=${encodeURIComponent(FAKE_WALLET)}` +
        `&resolution=1h&since=100&until=200&underwriter=phoenix`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cumulativePnl).toBe(12.5);
    expect(rows[0]!.unrealizedPnl).toBeNull();
  });

  it("getPnlHistory omits optional params when undefined", async () => {
    const { calls } = captureFetch([]);
    const client = new ImperialClient();
    await client.getPnlHistory(FAKE_WALLET, "1d");
    expect(calls[0]).toBe(
      `${BASE}/pnl-history?walletAddress=${encodeURIComponent(FAKE_WALLET)}&resolution=1d`
    );
  });

  it("getStatsSummary hits /stats/summary and parses headline + venues", async () => {
    const summary = {
      asOf: "2026-06-16T00:00:00Z",
      volume24hUsd: "1234567.89",
      volume7dUsd: "8000000",
      volumeAllUsd: "99000000",
      openInterestUsd: "456789.01",
      activeTraders24h: 42,
      feeRevenue24hUsd: "1234.56",
      venues: [
        { venue: "phoenix", volumeUsd: "1000", openInterestUsd: "500", traderCount: 7 },
      ],
    };
    const { calls } = captureFetch(summary);

    const client = new ImperialClient();
    const res = await client.getStatsSummary();

    expect(calls[0]).toBe(`${BASE}/stats/summary`);
    expect(res.volume24hUsd).toBe("1234567.89");
    expect(res.activeTraders24h).toBe(42);
    expect(res.venues[0]!.venue).toBe("phoenix");
    expect(res.venues[0]!.traderCount).toBe(7);
  });

  it("getStatsMarkets appends period only when supplied", async () => {
    const { calls } = captureFetch({ period: "24h", rows: [] });
    const client = new ImperialClient();
    await client.getStatsMarkets();
    await client.getStatsMarkets("7d");
    expect(calls[0]).toBe(`${BASE}/stats/markets`);
    expect(calls[1]).toBe(`${BASE}/stats/markets?period=7d`);
  });

  it("getStatsVolume appends only the supplied opts in order and parses rows", async () => {
    const { calls } = captureFetch({
      period: "7d",
      grouping: "day",
      rows: [
        {
          timestamp: "2026-06-16",
          totalUsd: "1000",
          jupiterUsd: "100",
          flashUsd: "200",
          phoenixUsd: "300",
          gmtradeUsd: "400",
          tradeCount: 5,
        },
      ],
    });
    const client = new ImperialClient();
    await client.getStatsVolume();
    const res = await client.getStatsVolume({ period: "7d", grouping: "day", venue: "phoenix" });
    expect(calls[0]).toBe(`${BASE}/stats/volume`);
    expect(calls[1]).toBe(`${BASE}/stats/volume?period=7d&grouping=day&venue=phoenix`);
    expect(res.rows[0]!.tradeCount).toBe(5);
    expect(res.rows[0]!.totalUsd).toBe("1000");
  });

  it("getStatsOpenInterest appends grouping only when supplied and parses rows", async () => {
    const { calls } = captureFetch({
      asOf: "2026-06-16T00:00:00Z",
      grouping: "venue",
      rows: [
        {
          label: "phoenix",
          longUsd: "600",
          shortUsd: "400",
          totalUsd: "1000",
          positionCount: 3,
          traderCount: 2,
        },
      ],
    });
    const client = new ImperialClient();
    await client.getStatsOpenInterest();
    const res = await client.getStatsOpenInterest("venue");
    expect(calls[0]).toBe(`${BASE}/stats/open-interest`);
    expect(calls[1]).toBe(`${BASE}/stats/open-interest?grouping=venue`);
    expect(res.rows[0]!.label).toBe("phoenix");
    expect(res.rows[0]!.totalUsd).toBe("1000");
  });

  it("getOpenOrders uses profile_index (snake_case) and parses orders", async () => {
    const order = {
      wallet: FAKE_WALLET,
      profileIndex: 0,
      profilePda: "Profile111",
      orderPda: "Order111",
      parentOrderPda: null,
      underwriter: "phoenix",
      marketMint: "Mint111",
      side: "long",
      action: "increase",
      orderType: "limit",
      status: "open",
      sizeUsd: "1000000",
      collateralAmount: "100000",
      slippageBps: 50,
      triggerCondition: null,
      triggerPrice: null,
      createdAt: 1_700_000_000,
      creationSlot: 123,
      creationSignature: "Sig111",
      executedAt: null,
      executionSignature: null,
      cancelledAt: null,
    };
    const { calls } = captureFetch({ count: 1, orders: [order] });

    const client = new ImperialClient();
    const res = await client.getOpenOrders(FAKE_WALLET, {
      status: "open",
      limit: 25,
      profileIndex: 0,
    });

    expect(calls[0]).toBe(
      `${BASE}/passthrough/users/${encodeURIComponent(FAKE_WALLET)}/orders` +
        `?status=open&limit=25&profile_index=0`
    );
    expect(res.count).toBe(1);
    expect(res.orders[0]!.orderPda).toBe("Order111");
    expect(res.orders[0]!.parentOrderPda).toBeNull();
  });

  it("getOpenOrders omits the query string when no opts are passed", async () => {
    const { calls } = captureFetch({ count: 0, orders: [] });
    const client = new ImperialClient();
    await client.getOpenOrders(FAKE_WALLET);
    expect(calls[0]).toBe(
      `${BASE}/passthrough/users/${encodeURIComponent(FAKE_WALLET)}/orders`
    );
  });
});
