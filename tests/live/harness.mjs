/**
 * Shared harness for the live (real-network, real-money) Imperial test suite.
 *
 * Every scenario under tests/live/scenarios/ receives a single `ctx` built here:
 * the funded test wallet, a JWT (auth handshake, cached per run), an RPC
 * connection, transaction sign/submit/confirm, polling + balance/position
 * readers, request builders that mirror src/lib/order-builder.ts, and a
 * reporter. Keep all I/O primitives here so scenarios stay declarative.
 *
 * Wallet: .keys/test-wallet.json (pubkey HP29…). Real mainnet funds.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
const WALLET_PATH = path.join(REPO_ROOT, ".keys/test-wallet.json");

export const API = process.env.IMPERIAL_API_URL ?? "https://api.imperial.space";
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ───────────────────────────── scales + enums (mirror lib/order-builder.ts)

export const USD_SCALE = 1_000_000; // $1 → 1e6 (6-decimal fixed point)
export const PRICE_SCALE = 1_000_000_000; // $1 → 1e9 (oracle scale)
export const MIN_COLLATERAL_USD = 10;

export const Underwriter = { jupiter: 0, flash_trade: 1, phoenix: 2, gmtrade: 3 };
export const Side = { long: 0, short: 1 };
export const Action = { increase: 0, decrease: 1 };
export const OrderType = { market: 0, limit: 1, stopLimit: 2 };
export const TriggerCondition = { above: 0, below: 1 };

export const usdFixed = (d) => Math.round(d * USD_SCALE);
export const oracle = (d) => Math.round(d * PRICE_SCALE);

// MIRROR of src/lib/order-builder.ts toMarketPrice: a MARKET order's marketPrice
// scale is venue-specific — Phoenix wants 1e6 (USD 6-dec), the rest want 1e9.
const MARKET_PRICE_SCALE = { phoenix: USD_SCALE, jupiter: PRICE_SCALE, flash_trade: PRICE_SCALE, gmtrade: PRICE_SCALE };
export const marketPriceFixed = (d, venue) => Math.round(d * (MARKET_PRICE_SCALE[venue] ?? PRICE_SCALE));

// ───────────────────────────── colored reporter

const C = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m" };

export function makeReporter() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  return {
    section(name) {
      process.stdout.write(`\n${C.cyan}══ ${name} ══${C.reset}\n`);
    },
    ok(name, detail) {
      pass += 1;
      process.stdout.write(`${C.green}✓${C.reset} ${name}${detail ? `  ${C.dim}${detail}${C.reset}` : ""}\n`);
    },
    bad(name, e) {
      fail += 1;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${name}: ${msg}`);
      process.stdout.write(`${C.red}✗${C.reset} ${name}\n  ${C.yellow}${msg}${C.reset}\n`);
    },
    info(line) {
      process.stdout.write(`${C.dim}  ${line}${C.reset}\n`);
    },
    warn(line) {
      process.stdout.write(`${C.yellow}  ⚠ ${line}${C.reset}\n`);
    },
    assert(cond, name, detail) {
      if (cond) this.ok(name, detail);
      else this.bad(name, new Error(detail ?? "assertion failed"));
      return !!cond;
    },
    summary() {
      process.stdout.write(
        `\n${pass} passed, ${fail} failed.\n${fail ? failures.map((f) => `  - ${f}`).join("\n") + "\n" : ""}`
      );
      return { pass, fail };
    },
    get counts() {
      return { pass, fail };
    },
  };
}

// ───────────────────────────── wallet + http

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"))));
export const WALLET = kp.publicKey.toBase58();
export { kp };

const RETRY_TLS_CODES = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "UND_ERR_SOCKET"]);

export async function http(method, p, { body, jwt, retries = 4 } = {}) {
  const headers = { "content-type": "application/json" };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetch(`${API}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      const code = e?.cause?.code ?? e?.code;
      lastErr = new Error(`${method} ${p}: ${e.message} (${code ?? "?"})`);
      if (attempt < retries && (RETRY_TLS_CODES.has(code) || !code)) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (res.status >= 500 && res.status <= 599 && attempt < retries) {
      lastErr = new Error(`${method} ${p}: ${res.status} ${JSON.stringify(parsed)}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    return { status: res.status, body: parsed };
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pollUntil(pred, { timeoutMs = 60_000, intervalMs = 3_000 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

function makeNonce() {
  // Imperial requires a u64 nonce within ±5min; Date.now() ms is canonical.
  return Date.now().toString();
}

function signConnectMessage(message) {
  const seed = kp.secretKey.slice(0, 32);
  return bs58.encode(ed25519.sign(new TextEncoder().encode(message), seed));
}

let _jwt = null;
/** Run (and cache) the connect+exchange handshake for this process. */
export async function ensureJwt() {
  if (_jwt) return _jwt;
  const nonce = makeNonce();
  const message = `imperial:mobile-connect:${WALLET}:${nonce}`;
  const connect = await http("POST", "/mobile/connect", { body: { wallet: WALLET, message, signature: signConnectMessage(message) } });
  if (connect.status !== 200 || !connect.body?.code) throw new Error(`connect ${connect.status}: ${JSON.stringify(connect.body)}`);
  const exchange = await http("POST", "/mobile/exchange", { body: { code: connect.body.code } });
  if (exchange.status !== 200 || !exchange.body?.jwt) throw new Error(`exchange ${exchange.status}: ${JSON.stringify(exchange.body)}`);
  _jwt = exchange.body.jwt;
  return _jwt;
}

// ───────────────────────────── on-chain

export function getRpc() {
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("set SOLANA_RPC=https://… for on-chain scenarios");
  return new Connection(url, "confirmed");
}

/**
 * Retry transient RPC failures (gateway 5xx, timeouts, rate limits). Free public
 * RPCs (publicnode, mainnet) blip frequently; this keeps the money flows
 * from aborting mid-sequence. Re-sending the same *signed* tx is idempotent
 * (same signature → the network dedupes), so retrying sends is safe.
 */
export async function rpcRetry(fn, label = "rpc", tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const transient = /\b(50\d|429)\b|timeout|gateway|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|socket/i.test(msg);
      if (transient && i < tries - 1) {
        await sleep(800 * 2 ** i);
        continue;
      }
      throw new Error(`${label}: ${msg.slice(0, 100)}`);
    }
  }
  throw lastErr;
}

/**
 * Confirm a signature by polling getSignatureStatuses over HTTP. We deliberately
 * avoid Connection.confirmTransaction, which opens a WebSocket signatureSubscribe
 * — free RPCs (publicnode) often don't serve WS on the HTTP URL, so it hangs.
 */
export async function confirmBySig(rpc, sig, { timeoutMs = 90_000, intervalMs = 2_500 } = {}) {
  const start = Date.now();
  for (;;) {
    const st = await rpcRetry(() => rpc.getSignatureStatuses([sig]), "getSignatureStatuses");
    const s = st.value[0];
    if (s) {
      if (s.err) throw new Error(`on-chain err: ${JSON.stringify(s.err)}`);
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return;
    }
    if (Date.now() - start >= timeoutMs) throw new Error(`confirm timeout for ${sig.slice(0, 12)}…`);
    await sleep(intervalMs);
  }
}

/** Sign a base64 partially-signed VersionedTransaction with the test wallet, submit, confirm. */
export async function signSubmitConfirm(rpc, base64, label = "tx") {
  const vtx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  vtx.sign([kp]);
  const sig = await rpcRetry(() => rpc.sendTransaction(vtx, { skipPreflight: false, maxRetries: 5 }), `${label} send`);
  await confirmBySig(rpc, sig);
  return sig;
}

export async function walletSol(rpc) {
  return (await rpcRetry(() => rpc.getBalance(kp.publicKey), "getBalance")) / 1e9;
}
export async function walletUsdc(rpc) {
  const accs = await rpcRetry(() => rpc.getParsedTokenAccountsByOwner(kp.publicKey, { mint: USDC_MINT }), "getTokenAccounts");
  return accs.value.reduce((a, x) => a + Number(x.account.data.parsed?.info?.tokenAmount?.amount ?? 0), 0) / 1e6;
}

// ───────────────────────────── Imperial reads

export async function getBalances(jwt) {
  const r = await http("GET", "/mobile/balances", { jwt });
  if (r.status !== 200) throw new Error(`balances ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.profiles ?? [];
}
export async function profileFreeUsd(jwt, profileIndex) {
  const profiles = await getBalances(jwt);
  return (profiles.find((p) => p.profileIndex === profileIndex)?.usdc ?? 0) / 1e6;
}
export async function getPositions(wallet = WALLET) {
  const r = await http("GET", `/positions?walletAddress=${wallet}`);
  if (r.status !== 200) throw new Error(`positions ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.dataList ?? [];
}
export async function findOpenPosition(asset, profileIndex, wallet = WALLET) {
  const list = await getPositions(wallet);
  return list.find(
    (p) =>
      p.asset === asset &&
      (profileIndex == null || p.profileIndex === profileIndex) &&
      (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0)
  );
}
export async function solMark() {
  const marks = await fetch(`${API}/api/v1/mark-prices`).then((r) => r.json());
  const row = marks.rows.find((r) => r.symbol === "SOL");
  const px = row?.phoenix?.price ?? row?.flash?.price;
  if (!px) throw new Error("no SOL mark price");
  return px;
}

export async function getRoute({ asset, side = "long", notional, desiredLeverage = 2 }) {
  const qs = new URLSearchParams({ asset, side, notional: String(notional), desiredLeverage: String(desiredLeverage) });
  const r = await http("GET", `/route?${qs}`);
  if (r.status !== 200) throw new Error(`route ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/**
 * MIRROR of src/lib/trade-flow.ts `marketVenueCandidates` (market case). Kept in
 * sync intentionally so the live suite exercises the same routing rule the UI
 * uses — the divergence between this harness and the frontend is exactly what
 * let the Phoenix-market bug slip through before.
 */
export function marketVenues(route, selectedVenue = "auto") {
  const cands = route?.candidates ?? [];
  if (cands.length === 0) return [selectedVenue !== "auto" ? selectedVenue : "gmtrade"];
  const viable = cands.filter((c) => !c.filteredReason).map((c) => c.venue); // keep Phoenix
  const head = route?.venue;
  let ordered = head ? [head, ...viable.filter((v) => v !== head)] : viable;
  if (ordered.length === 0) return [];
  if (selectedVenue !== "auto") ordered = [selectedVenue, ...ordered.filter((v) => v !== selectedVenue)];
  return [...new Set(ordered)];
}

// ───────────────────────────── request builders (mirror order-builder.ts)

/**
 * @param {{wallet?,profileIndex,venue,side,type,sizeUsd,collateralUsd,markPrice,
 *          limitPriceUsd?,slippageBps,symbol}} o
 */
export function buildOrder(o) {
  const side = Side[o.side];
  const isLimit = o.type === "limit";
  return {
    wallet: o.wallet ?? WALLET,
    profileIndex: o.profileIndex,
    underwriter: Underwriter[o.venue],
    side,
    action: Action.increase,
    orderType: isLimit ? OrderType.limit : OrderType.market,
    sizeUsd: usdFixed(o.sizeUsd),
    collateralAmount: usdFixed(o.collateralUsd),
    slippageBps: o.slippageBps ?? 200,
    triggerCondition: isLimit ? (side === Side.long ? TriggerCondition.below : TriggerCondition.above) : TriggerCondition.above,
    triggerPrice: isLimit ? oracle(o.limitPriceUsd) : 0,
    priority: 0,
    fundingStatus: 0,
    marketPrice: marketPriceFixed(o.markPrice, o.venue),
    symbol: o.symbol,
  };
}

export function buildClose(o) {
  return {
    wallet: o.wallet ?? WALLET,
    profileIndex: o.profileIndex,
    underwriter: Underwriter[o.venue],
    side: Side[o.positionSide],
    action: Action.decrease,
    orderType: OrderType.market,
    sizeUsd: usdFixed(o.sizeUsd),
    collateralAmount: 0,
    slippageBps: o.slippageBps ?? 200,
    triggerCondition: TriggerCondition.above,
    triggerPrice: 0,
    priority: 0,
    fundingStatus: 0,
    marketPrice: marketPriceFixed(o.markPrice, o.venue),
    symbol: o.symbol,
  };
}

// ───────────────────────────── composite on-chain actions (reused by scenarios)

/** Build a deposit/withdraw tx, sign with the wallet, submit + confirm. Returns sig. */
export async function buildSignSubmit(rpc, { profileIndex, amountUsd, mode }) {
  const b = await http("POST", "/deposit/build-tx", {
    body: { wallet: WALLET, profileIndex, amount: Math.round(amountUsd * USD_SCALE), mode },
  });
  if (b.status !== 200 || !b.body?.transaction) throw new Error(`${mode} build-tx ${b.status}: ${JSON.stringify(b.body)}`);
  return signSubmitConfirm(rpc, b.body.transaction, mode);
}

/** Top up `profileIndex` to `targetUsd` from the wallet, confirm, wait for it to land. */
export async function ensureFunded(rpc, jwt, profileIndex, targetUsd) {
  const free = await profileFreeUsd(jwt, profileIndex);
  if (free >= targetUsd) return { deposited: 0, sig: null };
  const dep = +(targetUsd - free).toFixed(6);
  const sig = await buildSignSubmit(rpc, { profileIndex, amountUsd: dep, mode: "deposit" });
  const ok = await pollUntil(async () => (await profileFreeUsd(jwt, profileIndex)) >= targetUsd - 1e-6);
  if (!ok) throw new Error(`deposit of $${dep} didn't settle into profile ${profileIndex}`);
  return { deposited: dep, sig };
}

/** Withdraw the entire free balance of `profileIndex` back to the wallet. */
export async function withdrawAll(rpc, jwt, profileIndex) {
  const free = await profileFreeUsd(jwt, profileIndex);
  if (free <= 0) return { withdrawn: 0, sig: null };
  const sig = await buildSignSubmit(rpc, { profileIndex, amountUsd: free, mode: "withdraw" });
  await pollUntil(async () => (await profileFreeUsd(jwt, profileIndex)) < 0.01, { timeoutMs: 30_000 });
  return { withdrawn: free, sig };
}

/** POST an order-bot order (open/close/limit/etc.); throws on rejection. */
export async function placeOrder(jwt, body, label = "order") {
  const r = await http("POST", "/mobile/orders", { body, jwt });
  if (r.status !== 200 || !r.body?.success) throw new Error(`${label}: ${r.body?.error ?? JSON.stringify(r.body)}`);
  return r.body;
}

/** Sweep non-USDC residue back to USDC (idempotent). */
export async function sweepProfile(profileIndex) {
  const r = await http("POST", `/passthrough/users/${WALLET}/profiles/${profileIndex}/sync`, { body: {} });
  return r.body ?? { status: `http ${r.status}` };
}

/** Build the ctx object handed to every scenario. */
export function makeCtx(reporter, options = {}) {
  const profile = Number(process.env.PROFILE ?? options.profile ?? 0);
  return {
    API,
    WALLET,
    kp,
    PROFILE: profile,
    USDC_MINT,
    options,
    // primitives
    http,
    sleep,
    pollUntil,
    ensureJwt,
    getRpc,
    signSubmitConfirm,
    // reads
    walletSol,
    walletUsdc,
    getBalances,
    profileFreeUsd,
    getPositions,
    findOpenPosition,
    solMark,
    getRoute,
    marketVenues,
    // composite actions
    buildSignSubmit,
    ensureFunded,
    withdrawAll,
    placeOrder,
    sweepProfile,
    // builders + scales
    buildOrder,
    buildClose,
    usdFixed,
    oracle,
    scales: { USD_SCALE, PRICE_SCALE, MIN_COLLATERAL_USD },
    enums: { Underwriter, Side, Action, OrderType, TriggerCondition },
    // reporting
    r: reporter,
  };
}
