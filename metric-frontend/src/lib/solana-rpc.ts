/**
 * Solana RPC endpoint selection with a hardcoded public fallback chain.
 *
 * Order of preference:
 *   1. NEXT_PUBLIC_SOLANA_RPC (env var) — typically Triton/Helius/QuickNode
 *      with a per-customer URL. Set in Vercel for production.
 *   2. https://api.mainnet-beta.solana.com — Solana Labs public RPC.
 *      Rate-limited; fine for the demo's deposit-once-an-hour use.
 *   3. https://solana-rpc.publicnode.com — publicnode.com fallback.
 *
 * Private endpoints stay in env vars (never in source). The public
 * fallbacks are safe to commit — they're shared community infra.
 */

const PUBLIC_FALLBACKS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;

/**
 * Normalize a Solana RPC URL — accept bare hosts (Triton's dashboard
 * shows them as `asymmetr-solanam-0245.mainnet.rpcpool.com`) and auto-
 * prefix `https://`. Reject empty / non-string. @solana/web3.js's
 * Connection constructor throws TypeError on anything without
 * `http:` or `https:`; we'd rather fail-soft to a public fallback than
 * crash prerendering.
 */
function normalize(url: string | undefined | null): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^(https?|wss?):\/\//.test(trimmed)) return trimmed;
  // Bare host (Triton/QuickNode often show this in their UI). Wallet
  // adapter wants HTTPS; HTTP downgrade only for explicit local dev.
  if (trimmed.startsWith("localhost") || trimmed.startsWith("127.0.0.1")) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

const envUrl = normalize(
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SOLANA_RPC : undefined
);

/** Ordered candidate list; first one is the synchronous default. */
export const SOLANA_RPC_CANDIDATES: readonly string[] = envUrl
  ? [envUrl, ...PUBLIC_FALLBACKS]
  : PUBLIC_FALLBACKS;

/**
 * Synchronous primary URL. Used by `WalletProvider`'s `ConnectionProvider`
 * (which doesn't support failover natively). If the primary is degraded,
 * the user can override via the env var; mid-session failover lives in
 * `submitWithFallback()` below for transaction submissions.
 */
export const SOLANA_RPC_URL = SOLANA_RPC_CANDIDATES[0]!;

/**
 * Race the candidate URLs with a `getSlot` probe and return the first to
 * respond within `timeoutMs`. Use at app boot if you want to pick the
 * fastest live URL dynamically. Resolves to `SOLANA_RPC_URL` (the
 * synchronous primary) if every probe fails — that way the caller still
 * has a usable Connection even when the network is broken.
 */
export async function selectBestRpc(timeoutMs = 4000): Promise<string> {
  const probe = (url: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      signal: AbortSignal.timeout(timeoutMs),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      const body = await r.json();
      if (body.error) throw new Error(`${url} → ${body.error.message}`);
      return url;
    });
  try {
    return await Promise.any(SOLANA_RPC_CANDIDATES.map(probe));
  } catch {
    return SOLANA_RPC_URL;
  }
}
