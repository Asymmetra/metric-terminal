import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import {
  confirmSignatureHttp,
  fetchWalletUsdc,
  selectBestRpc,
  SOLANA_RPC_CANDIDATES,
} from "./solana-rpc";

// jsdom's crypto makes the real web3.js findProgramAddressSync throw ("Unable to find a
// viable program address nonce"), which would force fetchWalletUsdc straight into its
// catch and mask the fetch logic under test. Mock @solana/web3.js with a minimal
// PublicKey: a well-formed base58-ish string derives an ATA; an obviously-invalid one
// throws (exercising the ctor-throws → null branch). This keeps the test deterministic
// and lets us assert the RPC walk / parsing rather than re-testing web3.js's crypto.
vi.mock("@solana/web3.js", () => {
  class FakePublicKey {
    constructor(public readonly key: string) {
      // Mirror web3.js: reject blatantly invalid input so the ctor-throws path is real.
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) {
        throw new Error(`Invalid public key input: ${key}`);
      }
    }
    toBytes() {
      return new Uint8Array(32);
    }
    toBase58() {
      return this.key;
    }
    static findProgramAddressSync() {
      return [new FakePublicKey("ATA1111111111111111111111111111111111111111"), 255] as const;
    }
  }
  return { PublicKey: FakePublicKey };
});

// A real funded mainnet wallet pubkey (test wallet) — passes the base58 shape check above.
const WALLET = "HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x";

/**
 * Per-URL fetch mock (mirrors imperial.test.ts's globalThis.fetch override). `handlers`
 * maps a substring of the request URL to the JSON body it should answer with (or a thrown
 * error). The first matching handler wins; an unmatched URL rejects (network-down).
 */
type Handler = { body?: unknown; status?: number; throws?: boolean };
function mockFetchByUrl(handlers: Record<string, Handler>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    const h = key ? handlers[key] : undefined;
    if (!h || h.throws) throw new Error(`network down: ${url}`);
    return new Response(JSON.stringify(h.body), { status: h.status ?? 200 });
  }) as typeof fetch;
  return { calls };
}

describe("solana-rpc candidate list (default env)", () => {
  it("defaults to the single public fallback when NEXT_PUBLIC_SOLANA_RPC is unset", () => {
    // The test env has no NEXT_PUBLIC_SOLANA_RPC, so the candidate chain is just
    // the committed public node — https://solana-rpc.publicnode.com.
    expect(SOLANA_RPC_CANDIDATES).toEqual(["https://solana-rpc.publicnode.com"]);
  });
});

describe("normalize / candidate ordering (env-driven, re-imported per case)", () => {
  const ORIG = process.env.NEXT_PUBLIC_SOLANA_RPC;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.NEXT_PUBLIC_SOLANA_RPC;
    else process.env.NEXT_PUBLIC_SOLANA_RPC = ORIG;
    vi.resetModules();
  });

  /** Re-evaluate the module with a given env value and read its computed candidates. */
  async function candidatesFor(envVal: string | undefined): Promise<readonly string[]> {
    if (envVal === undefined) delete process.env.NEXT_PUBLIC_SOLANA_RPC;
    else process.env.NEXT_PUBLIC_SOLANA_RPC = envVal;
    vi.resetModules();
    const mod = await import("./solana-rpc");
    return mod.SOLANA_RPC_CANDIDATES;
  }

  it("prefixes a bare host with https:// and lists it ahead of the public fallback", async () => {
    const c = await candidatesFor("asymmetr-solanam-0245.mainnet.rpcpool.com");
    expect(c[0]).toBe("https://asymmetr-solanam-0245.mainnet.rpcpool.com");
    expect(c[1]).toBe("https://solana-rpc.publicnode.com");
  });

  it("keeps an explicit https:// URL as-is", async () => {
    const c = await candidatesFor("https://mainnet.helius-rpc.com/?api-key=KEY");
    expect(c[0]).toBe("https://mainnet.helius-rpc.com/?api-key=KEY");
  });

  it("downgrades localhost / 127.0.0.1 to http:// (explicit local dev)", async () => {
    expect((await candidatesFor("localhost:8899"))[0]).toBe("http://localhost:8899");
    expect((await candidatesFor("127.0.0.1:8899"))[0]).toBe("http://127.0.0.1:8899");
  });

  it("falls back to the public node only when the env var is empty / whitespace", async () => {
    expect(await candidatesFor("")).toEqual(["https://solana-rpc.publicnode.com"]);
    expect(await candidatesFor("   ")).toEqual(["https://solana-rpc.publicnode.com"]);
  });
});

describe("fetchWalletUsdc", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the uiAmount from a working candidate", async () => {
    mockFetchByUrl({ publicnode: { body: { result: { value: { uiAmount: 42.5 } } } } });
    expect(await fetchWalletUsdc(WALLET)).toBe(42.5);
  });

  it("returns 0 when uiAmount is absent (?? 0)", async () => {
    mockFetchByUrl({ publicnode: { body: { result: { value: {} } } } });
    expect(await fetchWalletUsdc(WALLET)).toBe(0);
  });

  it("returns 0 when the RPC reports a missing ATA", async () => {
    mockFetchByUrl({
      publicnode: { body: { error: { message: "could not find account" } } },
    });
    expect(await fetchWalletUsdc(WALLET)).toBe(0);
  });

  it("treats 'not found' / 'does not exist' as a missing ATA → 0", async () => {
    mockFetchByUrl({ publicnode: { body: { error: { message: "Account does not exist" } } } });
    expect(await fetchWalletUsdc(WALLET)).toBe(0);
  });

  it("returns null when every candidate throws/rejects", async () => {
    // Only the single default candidate (publicnode) exists in this env, and it rejects.
    mockFetchByUrl({ publicnode: { throws: true } });
    expect(await fetchWalletUsdc(WALLET)).toBeNull();
  });

  it("returns null on an invalid wallet pubkey (PublicKey ctor throws)", async () => {
    // No fetch should even fire — derivation fails first.
    const { calls } = mockFetchByUrl({ publicnode: { body: {} } });
    expect(await fetchWalletUsdc("not-a-real-base58-pubkey!!!")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("walks the candidate chain: a non-fatal error on the primary falls through to a working fallback", async () => {
    // Re-import with a primary env URL so there are TWO candidates; the primary returns a
    // non-ATA error (so we 'continue' to the next), and the fallback answers a uiAmount.
    const ORIG = process.env.NEXT_PUBLIC_SOLANA_RPC;
    process.env.NEXT_PUBLIC_SOLANA_RPC = "https://primary.example.com";
    vi.resetModules();
    try {
      const mod = await import("./solana-rpc");
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("primary.example.com")) {
          // A method/forbidden style error that is NOT a missing-ATA → continue to next.
          return new Response(JSON.stringify({ error: { message: "403 forbidden" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: { value: { uiAmount: 12.25 } } }), { status: 200 });
      }) as typeof fetch;
      expect(await mod.fetchWalletUsdc(WALLET)).toBe(12.25);
      expect(calls.some((u) => u.includes("primary.example.com"))).toBe(true);
      expect(calls.some((u) => u.includes("publicnode"))).toBe(true);
    } finally {
      if (ORIG === undefined) delete process.env.NEXT_PUBLIC_SOLANA_RPC;
      else process.env.NEXT_PUBLIC_SOLANA_RPC = ORIG;
      vi.resetModules();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("confirmSignatureHttp", () => {
  /** A counting fake Connection whose getSignatureStatuses returns a scripted sequence. */
  function makeConn(
    statuses: Array<{ err: unknown; confirmationStatus: string | null } | null>,
    opts: { rejectEvery?: boolean } = {}
  ): { conn: Connection; calls: () => number } {
    let i = 0;
    const conn = {
      async getSignatureStatuses() {
        i += 1;
        if (opts.rejectEvery) throw new Error("rpc 500");
        const value = statuses[Math.min(i - 1, statuses.length - 1)];
        return { context: { slot: 0 }, value: [value] };
      },
    } as unknown as Connection;
    return { conn, calls: () => i };
  }

  const SIG = "5".repeat(64);

  it("resolves once a status reaches the wanted commitment ('confirmed' satisfies default)", async () => {
    const { conn, calls } = makeConn([
      { err: null, confirmationStatus: "processed" }, // not yet wanted
      { err: null, confirmationStatus: "confirmed" }, // satisfies default
    ]);
    await confirmSignatureHttp(conn, SIG, "confirmed", 5_000, 0);
    expect(calls()).toBe(2);
  });

  it("'finalized' commitment is NOT satisfied by a mere 'confirmed' status", async () => {
    const { conn, calls } = makeConn([
      { err: null, confirmationStatus: "confirmed" }, // does not satisfy finalized
      { err: null, confirmationStatus: "finalized" }, // satisfies finalized
    ]);
    await confirmSignatureHttp(conn, SIG, "finalized", 5_000, 0);
    expect(calls()).toBe(2);
  });

  it("resolves immediately (no throw) when the status carries an on-chain err", async () => {
    // status.err is surfaced downstream via balances/order results, not thrown here.
    const { conn, calls } = makeConn([{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: null }]);
    await expect(confirmSignatureHttp(conn, SIG, "confirmed", 5_000, 0)).resolves.toBeUndefined();
    expect(calls()).toBe(1);
  });

  it("tolerates getSignatureStatuses rejecting (the .catch(()=>null)) and stops at timeout", async () => {
    vi.useFakeTimers();
    try {
      const { conn } = makeConn([null], { rejectEvery: true });
      const p = confirmSignatureHttp(conn, SIG, "confirmed", 50, 20);
      await vi.advanceTimersByTimeAsync(200);
      await expect(p).resolves.toBeUndefined(); // never throws despite every poll rejecting
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves quietly at timeoutMs and stops polling when status stays null (bounded calls)", async () => {
    vi.useFakeTimers();
    try {
      const { conn, calls } = makeConn([null]); // never confirms
      const p = confirmSignatureHttp(conn, SIG, "confirmed", 100, 25);
      await vi.advanceTimersByTimeAsync(500); // well past the 100ms deadline
      await expect(p).resolves.toBeUndefined();
      // deadline 100ms / interval 25ms ⇒ a small bounded number of polls, not unbounded.
      expect(calls()).toBeLessThanOrEqual(6);
      expect(calls()).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("selectBestRpc", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the first candidate whose getSlot probe answers 200 with no body.error", async () => {
    mockFetchByUrl({ publicnode: { body: { jsonrpc: "2.0", id: 1, result: 123456 } } });
    expect(await selectBestRpc(50)).toBe("https://solana-rpc.publicnode.com");
  });

  it("falls back to SOLANA_RPC_URL when every probe throws", async () => {
    mockFetchByUrl({ publicnode: { throws: true } });
    expect(await selectBestRpc(50)).toBe(SOLANA_RPC_CANDIDATES[0]);
  });

  it("rejects a probe on non-ok HTTP and falls back", async () => {
    mockFetchByUrl({ publicnode: { body: { error: null }, status: 503 } });
    expect(await selectBestRpc(50)).toBe(SOLANA_RPC_CANDIDATES[0]);
  });

  it("rejects a probe whose body carries a JSON-RPC error and falls back", async () => {
    mockFetchByUrl({ publicnode: { body: { error: { message: "method not found" } } } });
    expect(await selectBestRpc(50)).toBe(SOLANA_RPC_CANDIDATES[0]);
  });

  it("picks a healthy primary over a broken fallback (re-imported with two candidates)", async () => {
    const ORIG = process.env.NEXT_PUBLIC_SOLANA_RPC;
    process.env.NEXT_PUBLIC_SOLANA_RPC = "https://primary.example.com";
    vi.resetModules();
    try {
      const mod = await import("./solana-rpc");
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("primary.example.com")) {
          return new Response(JSON.stringify({ result: 999 }), { status: 200 });
        }
        throw new Error("fallback down");
      }) as typeof fetch;
      expect(await mod.selectBestRpc(50)).toBe("https://primary.example.com");
    } finally {
      if (ORIG === undefined) delete process.env.NEXT_PUBLIC_SOLANA_RPC;
      else process.env.NEXT_PUBLIC_SOLANA_RPC = ORIG;
      vi.resetModules();
      globalThis.fetch = originalFetch;
    }
  });
});
