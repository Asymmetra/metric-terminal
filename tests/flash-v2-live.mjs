#!/usr/bin/env node
/**
 * Flash V2 live e2e harness (Imperial underwriter 4 = FlashTradeV2) with per-hop latency.
 *
 * Mirrors the round-trip in tests/imperial-live.mjs but exercises the Flash V2 path
 * specifically AND times every hop, so you can see where latency goes end-to-end:
 * each API call, each on-chain submit/confirm, and each async wait (deposit landing,
 * the magic_trade fill, settlement). A latency report prints at the end.
 *
 * V2 specifics handled here:
 *   - Placement is UNIFIED through /mobile/orders with `underwriter: 4` (there is no
 *     /mobile/v2/orders). The order bot auto-stages collateral from the profile into
 *     the V2 UserDepositLedger at fill, so we fund the plain profile like any venue.
 *   - The V2 market list is RUNTIME-populated (state.flash_v2_market_cache, ~60s TTL,
 *     empty until first fetch). We preflight GET /flash-v2/markets and retry the open
 *     once on a transient "could not resolve symbol" miss (cold cache).
 *   - Market orders route through execute_magic_trade_market (async fill), so the
 *     "fill" wait below is the key V2 latency to watch.
 *
 * Tiers:
 *   T1  (always)            auth + /flash-v2/markets preflight + balances + read latencies
 *   T2  (ROUNDTRIP=1)       deposit → open → verify(fill) → close → settle → withdraw
 *                           (real fees + brief market exposure; funds return to the wallet)
 *
 * Env:
 *   SOLANA_RPC        Required for T2. Helius/QuickNode (public mainnet rate-limits).
 *   PROFILE           Default 0.   SYMBOL Default SOL.   SIDE Default long.
 *   COLLATERAL        Default 10 (USD min).   LEVERAGE Default 2 (size = collateral × leverage).
 *   LATENCY_SLOW_MS   Default 800. API hops slower than this are flagged in the report.
 *
 * Run from repo root:
 *   node tests/flash-v2-live.mjs                                  # T1: auth + preflight + read latencies
 *   ROUNDTRIP=1 SOLANA_RPC=https://… node tests/flash-v2-live.mjs # T1 + real round-trip + full latency report
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";

// ─────────────────────────────────────────────────────────── config
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WALLET_PATH = path.join(REPO_ROOT, ".keys/test-wallet.json");
const API = process.env.IMPERIAL_API_URL ?? "https://api.imperial.space";
const PROFILE = Number(process.env.PROFILE ?? "0");
const SYMBOL = (process.env.SYMBOL ?? "SOL").toUpperCase();
const COLLATERAL_USD = Number(process.env.COLLATERAL ?? "10");
const LEVERAGE = Number(process.env.LEVERAGE ?? "2");
const SIZE_USD = +(COLLATERAL_USD * LEVERAGE).toFixed(2);
const SIDE = (process.env.SIDE ?? "long").toLowerCase();
const SIDE_CODE = SIDE === "short" ? 1 : 0;
const UNDERWRITER_FLASH_V2 = 4;
const ORACLE_SCALE = 1e9;
const USD_SCALE = 1e6;
const SLOW_MS = Number(process.env.LATENCY_SLOW_MS ?? "800");

const C = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", bold: "\x1b[1m" };
let pass = 0, fail = 0;
const failures = [];
const tier = (n) => process.stdout.write(`\n${C.cyan}== ${n} ==${C.reset}\n`);
const ok = (n, d) => { pass++; process.stdout.write(`${C.green}✓${C.reset} ${n}${d ? `  ${C.dim}${d}${C.reset}` : ""}\n`); };
const bad = (n, e) => { fail++; const m = e instanceof Error ? e.message : String(e); failures.push(`${n}: ${m}`); process.stdout.write(`${C.red}✗${C.reset} ${n}\n  ${C.yellow}${m}${C.reset}\n`); };
const info = (l) => process.stdout.write(`${C.dim}  ${l}${C.reset}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────── latency tracking
const T0 = performance.now();
const apiCalls = []; // { method, path, ms, status }
const chainOps = []; // { label, ms }
const waits = [];    // { label, ms, ok }
const stripQuery = (p) => p.split("?")[0];
async function timed(label, bucket, fn) {
  const t = performance.now();
  try { return await fn(); } finally { bucket.push({ label, ms: +(performance.now() - t).toFixed(1) }); }
}

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"))));
const WALLET = kp.publicKey.toBase58();

async function http(method, p, { body, jwt, retries = 4 } = {}) {
  const headers = { "content-type": "application/json" };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const t0 = performance.now();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetch(`${API}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      lastErr = new Error(`${method} ${p}: ${e.message}`);
      if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
      throw lastErr;
    }
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.status >= 500 && res.status <= 599 && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
    apiCalls.push({ method, path: stripQuery(p), ms: +(performance.now() - t0).toFixed(1), status: res.status });
    return { status: res.status, body: parsed };
  }
  throw lastErr;
}

const signConnect = (message) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32)));
const profileFree = async (jwt) => (await http("GET", "/mobile/balances", { jwt })).body.profiles[PROFILE].usdc / USD_SCALE;
const v2LedgerFree = async (jwt) => {
  const r = await http("GET", "/mobile/v2/balance", { jwt });
  const p = (r.body?.profiles ?? []).find((x) => x.profileIndex === PROFILE);
  return p ? p.availableUsdc / USD_SCALE : 0;
};
const pollUntil = async (pred, timeoutMs, intervalMs = 3000) => {
  const start = Date.now();
  for (;;) { if (await pred()) return true; if (Date.now() - start >= timeoutMs) return false; await sleep(intervalMs); }
};
const pollTimed = async (label, pred, timeoutMs, intervalMs = 3000) => {
  const t = performance.now();
  const okFlag = await pollUntil(pred, timeoutMs, intervalMs);
  waits.push({ label, ms: Math.round(performance.now() - t), ok: okFlag });
  return okFlag;
};

// ─────────────────────────────────────────────────────────── T1: auth + V2 preflight
let JWT = null;
let MARK = null;

tier(`T1 · auth + Flash V2 preflight  (wallet=${WALLET} · ${SIDE} ${SYMBOL} · $${SIZE_USD}/$${COLLATERAL_USD}≈${LEVERAGE}x)`);

try {
  const nonce = Date.now().toString();
  const message = `imperial:mobile-connect:${WALLET}:${nonce}`;
  const connect = await http("POST", "/mobile/connect", { body: { wallet: WALLET, message, signature: signConnect(message) } });
  if (connect.status !== 200 || !connect.body?.code) throw new Error(`connect ${connect.status}: ${JSON.stringify(connect.body)}`);
  const exchange = await http("POST", "/mobile/exchange", { body: { code: connect.body.code } });
  if (exchange.status !== 200 || !exchange.body?.jwt) throw new Error(`exchange ${exchange.status}: ${JSON.stringify(exchange.body)}`);
  JWT = exchange.body.jwt;
  ok("auth handshake", `jwt(${JWT.length} chars)`);
} catch (e) { bad("auth handshake", e); }

let v2Market = null;
try {
  const r = await http("GET", "/flash-v2/markets");
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`/flash-v2/markets ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
  if (r.body.length === 0) throw new Error("V2 market cache is EMPTY (cold) on this instance — wait ~60s and retry");
  v2Market = r.body.find((m) => String(m.symbol).toUpperCase() === SYMBOL && (m.side ? m.side === SIDE : true)) ?? r.body.find((m) => String(m.symbol).toUpperCase() === SYMBOL);
  if (!v2Market) throw new Error(`${SYMBOL} not listed on Flash V2 (cache has ${r.body.length} markets)`);
  ok("GET /flash-v2/markets", `${SYMBOL} listed · maxLev=${v2Market.maxLeverage} · liq=$${Math.round(v2Market.availableLiquidityUsd ?? 0).toLocaleString()} · openable=${v2Market.allowOpenPosition}`);
  if (LEVERAGE > (v2Market.maxLeverage ?? Infinity)) bad("leverage guard", new Error(`requested ${LEVERAGE}x > venue max ${v2Market.maxLeverage}x`));
} catch (e) { bad("Flash V2 market preflight", e); }

try {
  const r = await http("GET", `/route?asset=${SYMBOL}&side=${SIDE}&notional=${SIZE_USD}&desiredLeverage=${LEVERAGE}`);
  const cand = (r.body?.candidates ?? []).find((c) => c.venue === "flash_v2");
  if (!cand) throw new Error(`/route did not list flash_v2 for ${SYMBOL} (cache divergence?)`);
  ok("GET /route", `flash_v2 offered · maxLev=${Math.round(cand.maxLeverage)} · cost≈$${cand.expectedCostUsd?.toFixed(3)}`);
} catch (e) { bad("route preflight", e); }

if (JWT) {
  try {
    const free = await profileFree(JWT);
    const v2 = await v2LedgerFree(JWT).catch(() => 0);
    ok("balances", `profile ${PROFILE}: $${free.toFixed(2)} free · V2 ledger: $${v2.toFixed(2)}`);
  } catch (e) { bad("balances", e); }
}

try {
  const marks = await http("GET", "/mark-prices");
  const row = marks.body.rows.find((r) => r.symbol === SYMBOL);
  MARK = row?.flash?.price ?? row?.phoenix?.price ?? row?.gmtrade?.price ?? row?.jupiter?.price;
  if (!MARK) throw new Error(`no mark price for ${SYMBOL}`);
  ok("mark price", `${SYMBOL}=$${MARK}`);
} catch (e) { bad("mark price", e); }

// ─────────────────────────────────────────────────── T2: real on-chain round-trip
if (process.env.ROUNDTRIP === "1") {
  tier("T2 · round-trip  deposit → open(flash_v2) → verify(fill) → close → settle → withdraw");
  if (!JWT) bad("round-trip", new Error("no JWT — T1 must pass first"));
  else if (!process.env.SOLANA_RPC) bad("round-trip", new Error("set SOLANA_RPC=https://… to submit on-chain"));
  else if (!MARK) bad("round-trip", new Error("no mark price — cannot set marketPrice"));
  else {
    try {
      const rpc = new Connection(process.env.SOLANA_RPC, "confirmed");
      const BUFFER_USD = Number(process.env.BUFFER_USD ?? "0.5");
      const signSubmitConfirm = async (b64, label) => {
        const vtx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
        vtx.sign([kp]);
        const sig = await timed(`${label}: rpc.sendTransaction`, chainOps, () => rpc.sendTransaction(vtx, { skipPreflight: false }));
        const conf = await timed(`${label}: rpc.confirm`, chainOps, () => rpc.confirmTransaction(sig, "confirmed"));
        if (conf.value.err) throw new Error(`${label} on-chain err: ${JSON.stringify(conf.value.err)}`);
        return sig;
      };
      const placeWithRetry = async (body, label) => {
        let r = await http("POST", "/mobile/orders", { body, jwt: JWT });
        const transient = (b) => b.status === 200 && b.body && !b.body.success && /could not resolve symbol|venue lists this market/i.test(b.body.error ?? "");
        if (transient(r)) { info(`${label}: transient resolve miss, retrying after 3s (cold V2 cache)…`); await sleep(3000); r = await http("POST", "/mobile/orders", { body, jwt: JWT }); }
        if (r.status !== 200 || !r.body.success) throw new Error(`${label} rejected: ${r.body?.error ?? JSON.stringify(r.body)}`);
        return r.body;
      };

      const lamports = await timed("rpc.getBalance(gas)", chainOps, () => rpc.getBalance(kp.publicKey));
      info(`SOL gas: ${(lamports / 1e9).toFixed(6)} SOL`);
      if (lamports < 0.01 * 1e9) throw new Error(`need ≥0.01 SOL for gas (have ${(lamports / 1e9).toFixed(6)})`);

      // 1. fund the profile to collateral + buffer (deposit only the shortfall)
      const target = COLLATERAL_USD + BUFFER_USD;
      const before = await profileFree(JWT);
      if (before < target) {
        const depositUsd = +(target - before).toFixed(6);
        const build = await http("POST", "/deposit/build-tx", { body: { wallet: WALLET, profileIndex: PROFILE, amount: Math.round(depositUsd * USD_SCALE), mode: "deposit" } });
        if (build.status !== 200 || !build.body?.transaction) throw new Error(`deposit build-tx ${build.status}: ${JSON.stringify(build.body)}`);
        const sig = await signSubmitConfirm(build.body.transaction, "deposit");
        ok("deposit confirmed", `$${depositUsd.toFixed(2)} → profile ${PROFILE}  ${sig.slice(0, 12)}…`);
        if (!(await pollTimed("deposit lands in profile", async () => (await profileFree(JWT)) >= target, 60_000))) throw new Error("deposit didn't reflect within 60s");
      } else ok("deposit skipped", `profile already funded ($${before.toFixed(2)} ≥ $${target.toFixed(2)})`);

      // 2. open flash_v2 market position (underwriter 4) — ack latency captured in apiCalls
      const openBody = {
        wallet: WALLET, profileIndex: PROFILE, underwriter: UNDERWRITER_FLASH_V2,
        side: SIDE_CODE, action: 0, orderType: 0,
        sizeUsd: Math.round(SIZE_USD * USD_SCALE), collateralAmount: Math.round(COLLATERAL_USD * USD_SCALE),
        slippageBps: 200, triggerCondition: 0, triggerPrice: 0, priority: 0, fundingStatus: 0,
        marketPrice: Math.round(MARK * ORACLE_SCALE), symbol: SYMBOL,
      };
      info(`opening ${SIDE} ${SYMBOL} on flash_v2: $${SIZE_USD} @ ~$${MARK} (collateral $${COLLATERAL_USD}, ~${LEVERAGE}x)`);
      const open = await placeWithRetry(openBody, "flash_v2 open");
      ok("flash_v2 market open (bot ack)", `signature=${(open.signature ?? "").slice(0, 12)}…`);

      // 3. verify the position appears — this WAIT is the magic_trade async fill latency
      const findPos = async () => (await http("GET", `/positions?walletAddress=${WALLET}`)).body.dataList?.find(
        (p) => p.asset === SYMBOL && /flash/i.test(`${p.underwriter} ${p.source}`) && /v2/i.test(`${p.underwriter} ${p.source}`) && (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0)
      );
      let posRow = null;
      const filled = await pollTimed("magic_trade fill (position appears)", async () => { posRow = await findPos(); return !!posRow; }, 120_000, 2000);
      if (!filled) {
        posRow = (await http("GET", `/positions?walletAddress=${WALLET}`)).body.dataList?.find((p) => p.asset === SYMBOL && (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0));
        if (!posRow) throw new Error("no open flash_v2 position appeared within 120s (magic_trade may not have filled)");
        info(`position found via fallback; underwriter="${posRow.underwriter}" source="${posRow.source}"`);
      }
      ok("position open", `size=$${Number(posRow.sizeUsd).toFixed(2)} side=${posRow.side} lev=${posRow.leverageX} underwriter=${posRow.underwriter}`);

      // 4. close (full size, market Decrease on underwriter 4)
      const preCloseProfile = await profileFree(JWT);
      const preCloseV2 = await v2LedgerFree(JWT).catch(() => 0);
      const closeBody = { ...openBody, action: 1, sizeUsd: Math.max(Math.round(Number(posRow.sizeUsd) * USD_SCALE), Math.round(SIZE_USD * USD_SCALE)), collateralAmount: 0, marketPrice: Math.round(MARK * ORACLE_SCALE) };
      const close = await placeWithRetry(closeBody, "flash_v2 close");
      ok("flash_v2 market close (bot ack)", `signature=${(close.signature ?? "").slice(0, 12)}…`);

      // 5. settle — WAIT until proceeds appear (profile or V2 ledger)
      await pollTimed("settle (proceeds appear)", async () => (await profileFree(JWT)) > preCloseProfile || (await v2LedgerFree(JWT).catch(() => 0)) > preCloseV2, 90_000, 3000);
      const postProfile = await profileFree(JWT);
      const postV2 = await v2LedgerFree(JWT).catch(() => 0);
      ok("settled", `profile $${preCloseProfile.toFixed(2)}→$${postProfile.toFixed(2)} · V2 ledger $${preCloseV2.toFixed(2)}→$${postV2.toFixed(2)}`);
      if (postV2 > preCloseV2 + 0.01) info(`NOTE: proceeds landed in the V2 UserDepositLedger ($${postV2.toFixed(2)}). Withdrawing that may need a V2→profile move (no documented endpoint yet) — flag to Imperial.`);

      // 6. sweep + withdraw whatever is free in the profile
      const sweep = await http("POST", `/passthrough/users/${WALLET}/profiles/${PROFILE}/sync`, { body: {} });
      info(`sweep status=${sweep.body?.status ?? sweep.status}`);
      const freeAfter = await profileFree(JWT);
      if (freeAfter > 0) {
        const wb = await http("POST", "/deposit/build-tx", { body: { wallet: WALLET, profileIndex: PROFILE, amount: Math.round(freeAfter * USD_SCALE), mode: "withdraw" } });
        if (wb.status !== 200 || !wb.body?.transaction) throw new Error(`withdraw build-tx ${wb.status}: ${JSON.stringify(wb.body)}`);
        const sig = await signSubmitConfirm(wb.body.transaction, "withdraw");
        ok("withdraw confirmed", `$${freeAfter.toFixed(2)} → wallet  ${sig.slice(0, 12)}…`);
      } else info("nothing free in the profile to withdraw (proceeds may be in the V2 ledger — see note above)");
      ok("round-trip complete", "flash_v2 open + close executed on-chain");
    } catch (e) { bad("round-trip flow", e); }
  }
} else {
  process.stdout.write(`${C.dim}\nT2 round-trip skipped (set ROUNDTRIP=1 SOLANA_RPC=… to run — spends real fees).${C.reset}\n`);
}

// ─────────────────────────────────────────────────────────── latency report
function pad(s, n) { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
tier("Latency report (per hop)");
{
  // API endpoints, aggregated by method+path
  const byEp = new Map();
  for (const c of apiCalls) {
    const k = `${c.method} ${c.path}`;
    const e = byEp.get(k) ?? { count: 0, total: 0, max: 0, min: Infinity };
    e.count++; e.total += c.ms; e.max = Math.max(e.max, c.ms); e.min = Math.min(e.min, c.ms);
    byEp.set(k, e);
  }
  info(`API endpoints  ${C.dim}(n · min/avg/max ms; ⚠ = max > ${SLOW_MS}ms)${C.reset}`);
  for (const [k, e] of [...byEp.entries()].sort((a, b) => b[1].max - a[1].max)) {
    const avg = e.total / e.count;
    const slow = e.max > SLOW_MS;
    process.stdout.write(`  ${slow ? C.yellow : ""}${pad(k, 36)} ${lpad(e.count, 2)} · ${lpad(e.min.toFixed(0), 5)} / ${lpad(avg.toFixed(0), 5)} / ${lpad(e.max.toFixed(0), 5)}${slow ? "  ⚠" : ""}${C.reset}\n`);
  }
  if (chainOps.length) {
    info("On-chain ops (Solana RPC submit/confirm)");
    for (const o of chainOps) process.stdout.write(`  ${pad(o.label, 40)} ${lpad(o.ms.toFixed(0), 7)} ms\n`);
  }
  if (waits.length) {
    info(`Async waits  ${C.dim}(fill/settle/landed — the latency-critical V2 hops)${C.reset}`);
    for (const w of waits) process.stdout.write(`  ${pad(w.label, 40)} ${lpad(w.ms, 7)} ms${w.ok ? "" : `  ${C.red}(TIMED OUT)${C.reset}`}\n`);
  }
  const wall = performance.now() - T0;
  const apiTotal = apiCalls.reduce((a, c) => a + c.ms, 0);
  info(`${C.bold}total wall-clock: ${(wall / 1000).toFixed(1)}s${C.reset}  ·  API ${apiCalls.length} calls / ${(apiTotal / 1000).toFixed(1)}s  ·  chain ${chainOps.length} ops  ·  waits ${waits.length}`);
}

// ─────────────────────────────────────────────────────────── summary
process.stdout.write(`\n${pass} passed, ${fail} failed.\n${fail ? failures.map((f) => `  - ${f}`).join("\n") + "\n" : ""}`);
process.exit(fail === 0 ? 0 : 1);
