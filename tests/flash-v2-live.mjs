#!/usr/bin/env node
/**
 * Flash V2 live e2e harness (Imperial underwriter 4 = FlashTradeV2) with per-hop latency
 * AND a leverage sweep to diagnose high-leverage fill failures.
 *
 * Mirrors the round-trip in tests/imperial-live.mjs but exercises the Flash V2 path
 * specifically. Two run modes:
 *   - single round-trip (ROUNDTRIP=1) at LEVERAGE
 *   - leverage SWEEP (SWEEP=1) that ratchets through LEVERAGES (default 495→2),
 *     opening + closing at each and recording: bot ack ok/err, whether the async
 *     magic_trade fill landed (or timed out), per-level fill latency, and where
 *     close proceeds settle. This isolates WHERE high-leverage orders break — at
 *     create-ack vs the async fill.
 *
 * V2 specifics:
 *   - Unified placement via /mobile/orders with `underwriter: 4` (no /mobile/v2/orders).
 *     The bot auto-stages collateral from the profile into the V2 UserDepositLedger at
 *     fill, so we fund the plain profile like any venue.
 *   - /route reports flash_v2 viable + unclamped to ~495x for SOL, so a fill failure at
 *     high leverage is an EXECUTION issue (magic_trade), not routing — hence this sweep.
 *   - Market orders fill async (execute_magic_trade_market); "fill" below is that latency.
 *
 * Env:
 *   SOLANA_RPC        Required for any on-chain tier. Helius/QuickNode.
 *   PROFILE 0 · SYMBOL SOL · SIDE long · COLLATERAL 10 (USD min)
 *   LEVERAGE          Default 2.   Single round-trip leverage (ROUNDTRIP mode).
 *   LEVERAGES         Default "495,450,350,250,100,50,2".  Sweep ladder (SWEEP mode).
 *   FILL_TIMEOUT_MS   Default 45000. How long to wait for the magic_trade fill per level.
 *   LATENCY_SLOW_MS   Default 800. API hops slower than this are flagged.
 *
 * Run from repo root:
 *   node tests/flash-v2-live.mjs                                       # T1 preflight only
 *   SWEEP=1 SOLANA_RPC=https://… node tests/flash-v2-live.mjs          # ratchet 495→2, diagnose fills
 *   ROUNDTRIP=1 LEVERAGE=495 SOLANA_RPC=https://… node tests/flash-v2-live.mjs  # single level
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
const SIDE = (process.env.SIDE ?? "long").toLowerCase();
const SIDE_CODE = SIDE === "short" ? 1 : 0;
const LEVERAGE = Number(process.env.LEVERAGE ?? "2");
const LEVERAGES = (process.env.LEVERAGES ?? "495,450,350,250,100,50,2").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const FILL_TIMEOUT_MS = Number(process.env.FILL_TIMEOUT_MS ?? "45000");
const SLOW_MS = Number(process.env.LATENCY_SLOW_MS ?? "800");
const BUFFER_USD = Number(process.env.BUFFER_USD ?? "0.5");
const UNDERWRITER_FLASH_V2 = 4;
const ORACLE_SCALE = 1e9;
const USD_SCALE = 1e6;

const C = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", bold: "\x1b[1m" };
let pass = 0, fail = 0;
const failures = [];
const tier = (n) => process.stdout.write(`\n${C.cyan}== ${n} ==${C.reset}\n`);
const ok = (n, d) => { pass++; process.stdout.write(`${C.green}✓${C.reset} ${n}${d ? `  ${C.dim}${d}${C.reset}` : ""}\n`); };
const bad = (n, e) => { fail++; const m = e instanceof Error ? e.message : String(e); failures.push(`${n}: ${m}`); process.stdout.write(`${C.red}✗${C.reset} ${n}\n  ${C.yellow}${m}${C.reset}\n`); };
const info = (l) => process.stdout.write(`${C.dim}  ${l}${C.reset}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

// ─────────────────────────────────────────────────────────── latency tracking
const T0 = performance.now();
const apiCalls = []; // { method, path, ms, status }
const chainOps = []; // { label, ms }
const waits = [];    // { label, ms, ok }
const stripQuery = (p) => p.split("?")[0];
async function timed(label, bucket, fn) { const t = performance.now(); try { return await fn(); } finally { bucket.push({ label, ms: +(performance.now() - t).toFixed(1) }); } }

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
const v2LedgerFree = async (jwt) => { const r = await http("GET", "/mobile/v2/balance", { jwt }); const p = (r.body?.profiles ?? []).find((x) => x.profileIndex === PROFILE); return p ? p.availableUsdc / USD_SCALE : 0; };
const pollUntil = async (pred, timeoutMs, intervalMs = 2500) => { const start = Date.now(); for (;;) { if (await pred()) return true; if (Date.now() - start >= timeoutMs) return false; await sleep(intervalMs); } };
const pollTimed = async (label, pred, timeoutMs, intervalMs = 2000) => { const t = performance.now(); const okFlag = await pollUntil(pred, timeoutMs, intervalMs); waits.push({ label, ms: Math.round(performance.now() - t), ok: okFlag }); return okFlag; };

// ─────────────────────────────────────────────────────────── T1: auth + V2 preflight
let JWT = null, MARK = null, v2Market = null;
tier(`T1 · auth + Flash V2 preflight  (wallet=${WALLET} · ${SIDE} ${SYMBOL} · collateral $${COLLATERAL_USD})`);

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

try {
  const r = await http("GET", "/flash-v2/markets");
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`/flash-v2/markets ${r.status}`);
  if (r.body.length === 0) throw new Error("V2 market cache is EMPTY (cold) — wait ~60s and retry");
  v2Market = r.body.find((m) => String(m.symbol).toUpperCase() === SYMBOL && (m.side ? m.side === SIDE : true)) ?? r.body.find((m) => String(m.symbol).toUpperCase() === SYMBOL);
  if (!v2Market) throw new Error(`${SYMBOL} not listed on Flash V2`);
  ok("GET /flash-v2/markets", `${SYMBOL} ${SIDE} maxLev=${v2Market.maxLeverage} liq=$${Math.round(v2Market.availableLiquidityUsd ?? 0).toLocaleString()} maxPos=$${Math.round(v2Market.maxPositionSizeUsd ?? 0).toLocaleString()}`);
} catch (e) { bad("Flash V2 market preflight", e); }

try {
  const r = await http("GET", `/route?asset=${SYMBOL}&side=${SIDE}&notional=${COLLATERAL_USD * 100}&desiredLeverage=100`);
  const cand = (r.body?.candidates ?? []).find((c) => c.venue === "flash_v2");
  if (!cand) throw new Error(`/route did not list flash_v2 for ${SYMBOL}`);
  ok("GET /route", `flash_v2 maxLev=${Math.round(cand.maxLeverage)} cost≈$${cand.expectedCostUsd?.toFixed(3)}`);
} catch (e) { bad("route preflight", e); }

if (JWT) { try { ok("balances", `profile ${PROFILE}: $${(await profileFree(JWT)).toFixed(2)} free · V2 ledger: $${(await v2LedgerFree(JWT).catch(() => 0)).toFixed(2)}`); } catch (e) { bad("balances", e); } }
try { const marks = await http("GET", "/mark-prices"); const row = marks.body.rows.find((r) => r.symbol === SYMBOL); MARK = row?.flash?.price ?? row?.phoenix?.price ?? row?.gmtrade?.price ?? row?.jupiter?.price; if (!MARK) throw new Error(`no mark for ${SYMBOL}`); ok("mark price", `${SYMBOL}=$${MARK}`); } catch (e) { bad("mark price", e); }

// ─────────────────────────────────────────────────── on-chain machinery (shared)
function makeOnchain(rpc) {
  const signSubmitConfirm = async (b64, label) => {
    const vtx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    vtx.sign([kp]);
    const sig = await timed(`${label}: rpc.send`, chainOps, () => rpc.sendTransaction(vtx, { skipPreflight: false }));
    const conf = await timed(`${label}: rpc.confirm`, chainOps, () => rpc.confirmTransaction(sig, "confirmed"));
    if (conf.value.err) throw new Error(`${label} on-chain err: ${JSON.stringify(conf.value.err)}`);
    return sig;
  };
  // Ensure the profile has `target` USDC free, topping up from the wallet ATA if needed.
  const ensureFunded = async (target) => {
    let free = await profileFree(JWT);
    if (free >= target) return { topped: 0, free };
    const need = +(target - free).toFixed(6);
    const build = await http("POST", "/deposit/build-tx", { body: { wallet: WALLET, profileIndex: PROFILE, amount: Math.round(need * USD_SCALE), mode: "deposit" } });
    if (build.status !== 200 || !build.body?.transaction) throw new Error(`deposit build-tx ${build.status}: ${JSON.stringify(build.body)}`);
    await signSubmitConfirm(build.body.transaction, "deposit");
    if (!(await pollTimed("deposit lands in profile", async () => (await profileFree(JWT)) >= target, 60_000))) throw new Error("deposit didn't reflect within 60s");
    free = await profileFree(JWT);
    return { topped: need, free };
  };
  const placeWithRetry = async (body, label) => {
    let r = await http("POST", "/mobile/orders", { body, jwt: JWT });
    const transient = (b) => b.status === 200 && b.body && !b.body.success && /could not resolve symbol|venue lists this market/i.test(b.body.error ?? "");
    if (transient(r)) { await sleep(3000); r = await http("POST", "/mobile/orders", { body, jwt: JWT }); }
    return r;
  };
  return { signSubmitConfirm, ensureFunded, placeWithRetry };
}

const orderBody = (action, sizeUsd, collateralUsd) => ({
  wallet: WALLET, profileIndex: PROFILE, underwriter: UNDERWRITER_FLASH_V2, side: SIDE_CODE, action, orderType: 0,
  sizeUsd: Math.round(sizeUsd * USD_SCALE), collateralAmount: Math.round(collateralUsd * USD_SCALE),
  slippageBps: 200, triggerCondition: 0, triggerPrice: 0, priority: 0, fundingStatus: 0,
  marketPrice: Math.round(MARK * ORACLE_SCALE), symbol: SYMBOL,
});
const findV2Pos = async () => (await http("GET", `/positions?walletAddress=${WALLET}`)).body.dataList?.find(
  (p) => p.asset === SYMBOL && (p.status?.toLowerCase() === "open" || Number(p.sizeUsd) > 0)
);

/** Open at `level`, wait for fill, close, settle. Returns a diagnostic record. */
async function runLevel(level, oc) {
  const size = +(COLLATERAL_USD * level).toFixed(2);
  const rec = { level, size, ackOk: false, ackErr: null, filled: false, fillMs: null, closeOk: null, closeErr: null, proceeds: null };
  await oc.ensureFunded(COLLATERAL_USD + BUFFER_USD);

  // open
  const tAck = performance.now();
  const open = await oc.placeWithRetry(orderBody(0, size, COLLATERAL_USD), `open@${level}x`);
  rec.ackMs = Math.round(performance.now() - tAck);
  if (open.status !== 200 || !open.body?.success) { rec.ackErr = open.body?.error ?? `status ${open.status}`; return rec; }
  rec.ackOk = true;
  rec.orderPda = open.body.orderPda ?? null;

  // wait for the async magic_trade fill
  let posRow = null;
  rec.filled = await pollTimed(`fill @${level}x`, async () => { posRow = await findV2Pos(); return !!posRow; }, FILL_TIMEOUT_MS, 2000);
  rec.fillMs = waits[waits.length - 1].ms;
  if (!rec.filled) {
    // didn't fill — release any staged/resting order so the next level can fund cleanly
    if (rec.orderPda) await http("POST", "/mobile/orders/cancel", { body: { wallet: WALLET, profileIndex: PROFILE, orderPda: rec.orderPda }, jwt: JWT }).catch(() => {});
    rec.profileAfter = await profileFree(JWT); rec.v2After = await v2LedgerFree(JWT).catch(() => 0);
    return rec;
  }
  rec.actualSize = Number(posRow.sizeUsd); rec.actualLev = posRow.leverageX;

  // close (full size) + settle
  const preProfile = await profileFree(JWT), preV2 = await v2LedgerFree(JWT).catch(() => 0);
  const close = await oc.placeWithRetry({ ...orderBody(1, Math.max(rec.actualSize, size), 0), sizeUsd: Math.round(Math.max(rec.actualSize, size) * USD_SCALE) }, `close@${level}x`);
  rec.closeOk = close.status === 200 && !!close.body?.success;
  if (!rec.closeOk) { rec.closeErr = close.body?.error ?? `status ${close.status}`; return rec; }
  await pollTimed(`settle @${level}x`, async () => (await profileFree(JWT)) > preProfile || (await v2LedgerFree(JWT).catch(() => 0)) > preV2, 90_000, 2500);
  const postProfile = await profileFree(JWT), postV2 = await v2LedgerFree(JWT).catch(() => 0);
  rec.proceeds = postProfile > preProfile + 0.01 ? "profile" : postV2 > preV2 + 0.01 ? "v2_ledger" : "none_seen";
  return rec;
}

// ─────────────────────────────────────────────────── T2: sweep / single round-trip
const doChain = process.env.SWEEP === "1" || process.env.ROUNDTRIP === "1";
const sweepResults = [];
if (doChain) {
  const ladder = process.env.SWEEP === "1" ? LEVERAGES : [LEVERAGE];
  tier(`T2 · ${process.env.SWEEP === "1" ? `leverage SWEEP  ${ladder.join("→")}x` : `round-trip @${LEVERAGE}x`}  (collateral $${COLLATERAL_USD}/trade)`);
  if (!JWT) bad("on-chain", new Error("no JWT — T1 must pass"));
  else if (!process.env.SOLANA_RPC) bad("on-chain", new Error("set SOLANA_RPC=https://… to submit on-chain"));
  else if (!MARK) bad("on-chain", new Error("no mark price"));
  else {
    const rpc = new Connection(process.env.SOLANA_RPC, "confirmed");
    const oc = makeOnchain(rpc);
    try {
      const lamports = await timed("rpc.getBalance(gas)", chainOps, () => rpc.getBalance(kp.publicKey));
      info(`SOL gas: ${(lamports / 1e9).toFixed(6)} SOL`);
      if (lamports < 0.01 * 1e9) throw new Error(`need ≥0.01 SOL for gas (have ${(lamports / 1e9).toFixed(6)})`);

      for (const level of ladder) {
        if (level > (v2Market?.maxLeverage ?? Infinity)) { info(`skip ${level}x > venue max ${v2Market?.maxLeverage}x`); continue; }
        info(`── ${level}x · size $${(COLLATERAL_USD * level).toFixed(0)} ──`);
        let rec;
        try { rec = await runLevel(level, oc); }
        catch (e) { rec = { level, size: +(COLLATERAL_USD * level).toFixed(2), ackOk: false, ackErr: e.message, filled: false }; }
        sweepResults.push(rec);
        if (rec.ackOk && rec.filled && rec.closeOk) ok(`${level}x filled`, `fill ${rec.fillMs}ms · proceeds→${rec.proceeds}`);
        else if (rec.ackOk && !rec.filled) bad(`${level}x NO FILL`, new Error(`bot acked but no fill in ${(FILL_TIMEOUT_MS / 1000)}s (magic_trade) · profile=$${(rec.profileAfter ?? 0).toFixed(2)} v2=$${(rec.v2After ?? 0).toFixed(2)}`));
        else if (!rec.ackOk) bad(`${level}x REJECTED at create`, new Error(rec.ackErr ?? "unknown"));
        else if (!rec.closeOk) bad(`${level}x filled but close failed`, new Error(rec.closeErr ?? "unknown"));
        // stop early if we can no longer fund a trade (proceeds stranded in V2 ledger / wallet dry)
        const free = await profileFree(JWT).catch(() => 0);
        const v2 = await v2LedgerFree(JWT).catch(() => 0);
        if (free < COLLATERAL_USD && v2 >= COLLATERAL_USD) { info(`stopping sweep: $${v2.toFixed(2)} stranded in V2 ledger (no V2→profile withdraw path); remaining levels skipped`); break; }
      }

      // final: withdraw whatever's free in the profile back to the wallet
      const freeAfter = await profileFree(JWT);
      if (freeAfter > 0.01) {
        const wb = await http("POST", "/deposit/build-tx", { body: { wallet: WALLET, profileIndex: PROFILE, amount: Math.round(freeAfter * USD_SCALE), mode: "withdraw" } });
        if (wb.status === 200 && wb.body?.transaction) { const sig = await oc.signSubmitConfirm(wb.body.transaction, "withdraw"); ok("withdraw", `$${freeAfter.toFixed(2)} → wallet ${sig.slice(0, 12)}…`); }
      }
    } catch (e) { bad("sweep flow", e); }
  }
} else {
  process.stdout.write(`${C.dim}\nT2 skipped — set SWEEP=1 (ladder) or ROUNDTRIP=1 (single) with SOLANA_RPC=… to run on-chain.${C.reset}\n`);
}

// ─────────────────────────────────────────────────────────── sweep results table
if (sweepResults.length) {
  tier("Leverage sweep results");
  info(`${pad("lev", 6)}${pad("size", 9)}${pad("ack", 8)}${pad("fill", 14)}${pad("close", 8)}proceeds / error`);
  for (const r of sweepResults) {
    const ackS = r.ackOk ? `${C.green}ok${C.reset}` : `${C.red}REJ${C.reset}`;
    const fillS = r.ackOk ? (r.filled ? `${C.green}${r.fillMs}ms${C.reset}` : `${C.red}NO FILL${C.reset}`) : "—";
    const closeS = r.filled ? (r.closeOk ? `${C.green}ok${C.reset}` : `${C.red}FAIL${C.reset}`) : "—";
    const note = !r.ackOk ? `${C.yellow}${r.ackErr ?? ""}${C.reset}` : !r.filled ? `${C.yellow}acked, no async fill${C.reset}` : !r.closeOk ? `${C.yellow}${r.closeErr ?? ""}${C.reset}` : (r.proceeds ?? "");
    process.stdout.write(`  ${pad(r.level + "x", 6)}${pad("$" + Math.round(r.size), 9)}${pad(ackS, 8 + 9)}${pad(fillS, 14 + 9)}${pad(closeS, 8 + 9)}${note}\n`);
  }
  const filledMax = sweepResults.filter((r) => r.filled).map((r) => r.level);
  const noFill = sweepResults.filter((r) => r.ackOk && !r.filled).map((r) => r.level);
  info(`highest leverage that FILLED: ${filledMax.length ? Math.max(...filledMax) + "x" : "none"}${noFill.length ? ` · acked-but-no-fill: ${noFill.join(",")}x` : ""}`);
}

// ─────────────────────────────────────────────────────────── latency report
tier("Latency report (per hop)");
{
  const byEp = new Map();
  for (const c of apiCalls) { const k = `${c.method} ${c.path}`; const e = byEp.get(k) ?? { count: 0, total: 0, max: 0, min: Infinity }; e.count++; e.total += c.ms; e.max = Math.max(e.max, c.ms); e.min = Math.min(e.min, c.ms); byEp.set(k, e); }
  info(`API endpoints  ${C.dim}(n · min/avg/max ms; ⚠ = max > ${SLOW_MS}ms)${C.reset}`);
  for (const [k, e] of [...byEp.entries()].sort((a, b) => b[1].max - a[1].max)) { const avg = e.total / e.count; const slow = e.max > SLOW_MS; process.stdout.write(`  ${slow ? C.yellow : ""}${pad(k, 36)} ${lpad(e.count, 2)} · ${lpad(e.min.toFixed(0), 5)} / ${lpad(avg.toFixed(0), 5)} / ${lpad(e.max.toFixed(0), 5)}${slow ? "  ⚠" : ""}${C.reset}\n`); }
  if (chainOps.length) { info("On-chain ops (Solana RPC submit/confirm)"); for (const o of chainOps) process.stdout.write(`  ${pad(o.label, 40)} ${lpad(o.ms.toFixed(0), 7)} ms\n`); }
  if (waits.length) { info(`Async waits  ${C.dim}(fill/settle/landed — the latency-critical V2 hops)${C.reset}`); for (const w of waits) process.stdout.write(`  ${pad(w.label, 40)} ${lpad(w.ms, 7)} ms${w.ok ? "" : `  ${C.red}(TIMED OUT)${C.reset}`}\n`); }
  const wall = performance.now() - T0; const apiTotal = apiCalls.reduce((a, c) => a + c.ms, 0);
  info(`${C.bold}total wall-clock: ${(wall / 1000).toFixed(1)}s${C.reset}  ·  API ${apiCalls.length} calls / ${(apiTotal / 1000).toFixed(1)}s  ·  chain ${chainOps.length} ops  ·  waits ${waits.length}`);
}

// ─────────────────────────────────────────────────────────── summary
process.stdout.write(`\n${pass} passed, ${fail} failed.\n${fail ? failures.map((f) => `  - ${f}`).join("\n") + "\n" : ""}`);
process.exit(fail === 0 ? 0 : 1);
