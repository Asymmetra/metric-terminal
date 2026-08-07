/**
 * Solana RPC endpoint selection with a hardcoded public fallback chain.
 *
 * Order of preference:
 *   1. NEXT_PUBLIC_SOLANA_RPC (env var) — typically Triton/Helius/QuickNode
 *      with a per-customer URL. Set in Vercel for production.
 *   2. https://solana-rpc.publicnode.com — publicnode.com fallback (returns
 *      200 to browser-origin requests).
 *
 * RECOMMENDED: for the fastest deposit/withdraw confirmation, point
 * NEXT_PUBLIC_SOLANA_RPC at a fast, CORS-friendly RPC. The Helius STANDARD
 * RPC works well from the browser:
 *   https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
 * Use the STANDARD endpoint above — NOT the Sender `/fast` low-latency
 * submit endpoint: Imperial is the fee-payer and pre-signs the tx, so the
 * client never broadcasts a trade and Sender's send-path optimizations don't
 * apply (the only on-chain action we broadcast is deposit/withdraw + its
 * getSignatureStatuses confirm, which just need a quick CORS-friendly node).
 * Never hardcode the key — keep it in the env var. The public node above
 * remains the fallback when the env primary is unset or browser-hostile.
 *
 * NOTE: the official public endpoint per solana.com/docs/references/clusters
 * is https://api.mainnet.solana.com, but it returns HTTP 403 to
 * browser-origin POSTs (Solana Labs blocks anonymous web traffic), so it is
 * intentionally NOT raced here — including it just spams the console with 403s
 * while the env primary wins anyway. rpc.ankr.com/solana likewise 403s now.
 *
 * Private endpoints stay in env vars (never in source). The public fallback is
 * safe to commit — shared community infra.
 */

import type { Commitment, Connection } from "@solana/web3.js";

const PUBLIC_FALLBACKS = ["https://solana-rpc.publicnode.com"] as const;

/**
 * Normalize a Solana RPC URL — accept bare hosts (Triton's dashboard
 * shows them as `<name>.mainnet.rpcpool.com`) and auto-
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

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Read a wallet's spendable USDC (uiAmount) via `getTokenAccountBalance`, walking the
 * RPC candidate chain so the browser-hostile primary (which 403s browser POSTs) falls
 * through to the public node. Returns 0 when the USDC ATA doesn't exist yet, and null
 * when no candidate answered (caller shows "—" rather than treating it as zero).
 */
export async function fetchWalletUsdc(wallet: string): Promise<number | null> {
  let ata: string;
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const owner = new PublicKey(wallet);
    ata = PublicKey.findProgramAddressSync(
      [owner.toBytes(), new PublicKey(TOKEN_PROGRAM).toBytes(), new PublicKey(USDC_MINT).toBytes()],
      new PublicKey(ATA_PROGRAM)
    )[0].toBase58();
  } catch {
    return null;
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [ata] });
  for (const url of SOLANA_RPC_CANDIDATES) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json();
      if (j.error) {
        // No USDC ATA yet → 0. Method/forbidden on this RPC → try the next candidate.
        if (/could not find|not found|does not exist/i.test(j.error.message ?? "")) return 0;
        continue;
      }
      return j.result?.value?.uiAmount ?? 0;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Confirm a signature by polling `getSignatureStatuses` over HTTP instead of
 * web3.js's `confirmTransaction`, which opens a `signatureSubscribe` WebSocket.
 *
 * Triton's bare-host RPC URL (e.g. `…rpcpool.com`) has no working anonymous
 * websocket, so the wallet-adapter Connection's auto-derived `wss://` endpoint
 * fails its handshake and reconnects forever — flooding the console with dozens
 * of "WebSocket connection failed" errors. `getSignatureStatuses` is a plain
 * HTTP RPC method, so polling it sidesteps the socket entirely.
 *
 * Best-effort by design: resolves when the signature reaches `commitment` (or on
 * an on-chain error, which downstream surfaces via balances / order results) and
 * otherwise resolves quietly at `timeoutMs`. Callers treat profile balances as
 * the authoritative settle gate, so a slow/absent confirm never blocks them.
 */
export async function confirmSignatureHttp(
  connection: Connection,
  signature: string,
  commitment: Commitment = "confirmed",
  timeoutMs = 30_000,
  intervalMs = 900
): Promise<void> {
  const want = commitment === "finalized" ? ["finalized"] : ["confirmed", "finalized"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature]).catch(() => null))?.value[0];
    if (status) {
      if (status.err) return; // surfaced by the balance gate / order result, not here
      if (status.confirmationStatus && want.includes(status.confirmationStatus)) return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
