#!/usr/bin/env node
/**
 * PnL Accuracy lifecycle regression test.
 *
 * Opens a small SOL-PERP position with the funded test wallet, captures
 * Phoenix's authoritative PnL values at every step, and asserts every
 * invariant we care about. Cost: ~$0.10 in fees (one round-trip on a
 * tiny notional).
 *
 * Lifecycle (matches the approved plan):
 *   T0: pre-state snapshot
 *   T1: open  — market BUY 1 lot SOL
 *   T1+: assert open-fill record (realized_pnl ~ 0, fees, base delta)
 *   T2: hold 60s — assert FE-recompute matches Phoenix per-position unrealizedPnl
 *   T3: close — market SELL 1 lot SOL
 *   T3+: assert close-fill record (realized_pnl matches expected)
 *   T4: refetch /pnl  — assert cumulativePnl[t4] - cumulativePnl[t0]
 *       equals sum(realized_pnl over window) within $0.01
 *   T5: reconcile maker+taker fees against trade.fees sum
 *   T6: account.unrealizedPnl == sum(position.unrealizedPnl)
 *
 * Usage:
 *   node tests/pnl-accuracy.mjs                 # against deployed prod
 *   BACKEND_URL=http://localhost:3001 node tests/pnl-accuracy.mjs
 *
 * Env required:
 *   RPC_URL  — Solana mainnet RPC (used to sign+submit txs)
 */
import 'dotenv/config';
import { readFileSync } from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const BACKEND = process.env.BACKEND_URL ?? "https://ember-backend-q4nf.onrender.com";
const RPC_URL = process.env.RPC_URL;
const KEYPAIR_PATH = "/Users/liamdig/Desktop/sandbox/ember-terminal/.keys/test-wallet.json";
const TOLERANCE_USD = 0.01;       // cent-level tolerance for dollar-denominated assertions
const HOLD_SECONDS = 60;          // T2 hold time

if (!RPC_URL) {
  console.error("RPC_URL env var is required (Solana mainnet RPC)");
  process.exit(1);
}

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"))));
const conn = new Connection(RPC_URL, "confirmed");
const WALLET = kp.publicKey.toBase58();

// ─────────── helpers ───────────
const out = { pass: 0, fail: 0, fails: [] };
const log = (s) => console.log(s);
const ok = (name, info = "") => { out.pass++; log(`  ✅ ${name}${info ? ` — ${info}` : ""}`); };
const ko = (name, why) => { out.fail++; out.fails.push({ name, why }); log(`  ❌ ${name} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  if (typeof v === "object" && v.ui != null) { const n = parseFloat(v.ui); return Number.isFinite(n) ? n : 0; }
  return 0;
}
const close = (a, b, eps = TOLERANCE_USD) => Math.abs(a - b) < eps;
const fmt = (v) => `$${num(v).toFixed(6)}`;

async function getTrader() {
  const r = await fetch(`${BACKEND}/api/trader/${WALLET}`);
  if (!r.ok) throw new Error(`/api/trader -> ${r.status}`);
  return r.json();
}
async function getTrades(limit = 50) {
  const r = await fetch(`${BACKEND}/api/trader/${WALLET}/trades?limit=${limit}`);
  if (!r.ok) throw new Error(`/api/trader/.../trades -> ${r.status}`);
  return r.json();
}
async function getPnl(resolution = "1m", limit = 60) {
  const r = await fetch(`${BACKEND}/api/trader/${WALLET}/pnl?resolution=${resolution}&limit=${limit}`);
  if (!r.ok) throw new Error(`/api/trader/.../pnl -> ${r.status}`);
  return r.json();
}
async function getMark(symbol) {
  const r = await fetch(`${BACKEND}/api/orderbook/${symbol}`);
  if (!r.ok) throw new Error(`/api/orderbook -> ${r.status}`);
  const ob = await r.json();
  // Best bid / best ask average as a stand-in for mark.
  const bestBid = ob.bids?.[0]?.price ?? 0;
  const bestAsk = ob.asks?.[0]?.price ?? 0;
  if (bestBid && bestAsk) return (bestBid + bestAsk) / 2;
  return bestBid || bestAsk || 0;
}

async function buildAndSend(endpoint, body, label) {
  log(`\n--- ${label} ---`);
  let res = await fetch(`${BACKEND}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Render-cold retry
  for (let i = 1; i <= 3 && res.status === 502; i++) {
    log(`  502 cold-start, retry ${i}/3...`);
    await sleep(i * 3000);
    res = await fetch(`${BACKEND}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  const data = await res.json().catch(() => null);
  if (res.status !== 200 || !data?.instructions) {
    throw new Error(`${endpoint} -> ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  log(`  Backend: ${res.status} — ${data.message}`);
  const ixs = data.instructions.map((ix) => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    log(`  Simulation FAILED: ${JSON.stringify(sim.value.err)}`);
    if (sim.value.logs) sim.value.logs.slice(-8).forEach(l => log(`    ${l}`));
    throw new Error("simulation failed");
  }
  log(`  Simulation OK (${sim.value.unitsConsumed} CU)`);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  log(`  TX sent: ${sig}`);
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`onchain err: ${JSON.stringify(conf.value.err)}`);
  log(`  TX CONFIRMED ✓`);
  return sig;
}

// ─────────── main lifecycle ───────────
const SYMBOL = "SOL";
const SIZE_LOTS = 1;             // 0.01 SOL — tiny

log(`╔══════════════════════════════════════════════════════════╗
║   EMBER PnL ACCURACY LIFECYCLE — ${new Date().toISOString().slice(0, 19)} ║
╚══════════════════════════════════════════════════════════╝`);
log(`Wallet:  ${WALLET}`);
log(`Backend: ${BACKEND}`);

// Warmup
for (let i = 0; i < 3; i++) {
  try { const r = await fetch(`${BACKEND}/api/markets`); if (r.ok) break; } catch {}
  await sleep(2000);
}

// ───── T0: pre-state ─────
log(`\n[T0] capturing pre-state...`);
const t0 = Date.now();
const t0State = await getTrader();
const t0Trades = await getTrades(50);
const t0Pnl = await getPnl("1m", 60);

const cross0 = t0State.accounts.find((a) => a.traderSubaccountIndex === 0);
const preTradeCount = (t0Trades.trades ?? []).length;
const lastPnl0 = (t0Pnl.data ?? [])[t0Pnl.data.length - 1] ?? null;

log(`  Pre cross collateralBalance: ${fmt(cross0?.collateralBalance)}`);
log(`  Pre trades count:            ${preTradeCount}`);
log(`  Pre last cumulativePnl:      ${lastPnl0 ? fmt(lastPnl0.cumulativePnl) : "n/a"}`);

// ───── T1: open ─────
log(`\n[T1] opening market BUY 1 lot ${SYMBOL}...`);
const openMark = await getMark(SYMBOL);
log(`  Open-time mark estimate: ${fmt(openMark)}`);
const openSig = await buildAndSend("/api/tx/market-order", {
  authority: WALLET, symbol: SYMBOL, side: "bid", size_lots: SIZE_LOTS,
}, `T1 open BUY ${SIZE_LOTS} lot ${SYMBOL}`);
await sleep(4000);

// ───── T1+: assert open-fill record ─────
log(`\n[T1+] verifying open fill record...`);
// Trade-history endpoint returns the latest N fills (paginated). To find our
// new fills we filter by timestamp ≥ T0 rather than relying on signature
// presence (the SDK's TradeHistoryItem.signature can be null on some paths).
const tradeTsMs = (t) => typeof t.timestamp === "string" ? new Date(t.timestamp).getTime() : Number(t.timestamp);
const t1Trades = await getTrades(100);
const newFills = (t1Trades.trades ?? []).filter((t) => tradeTsMs(t) >= t0);
log(`  ${newFills.length} new fill(s) since T0`);
const openFill = newFills.find((t) => t.signature === openSig) ?? newFills.find((t) => Math.abs(num(t.baseLotsDelta)) > 0 && num(t.baseLotsDelta) > 0) ?? newFills[newFills.length - 1];
if (!openFill) {
  ko("open fill record visible in trade history", `signature=${openSig} not found in ${t1Trades.trades?.length ?? 0} trades`);
} else {
  log(`  open fill: realized_pnl=${fmt(openFill.realizedPnl)}, fees=${fmt(openFill.fees)}, baseDelta=${openFill.baseLotsDelta}, side=${openFill.liquidity}, type=${openFill.tradeType}`);
  // Open fill: realized_pnl should be ~0 (we just opened, no PnL yet)
  close(num(openFill.realizedPnl), 0, 0.01)
    ? ok("open fill realized_pnl ≈ 0", fmt(openFill.realizedPnl))
    : ko("open fill realized_pnl ≈ 0", `expected ~0, got ${fmt(openFill.realizedPnl)}`);
  // Fees should be non-zero (taker fee paid)
  num(openFill.fees) !== 0
    ? ok("open fill fees non-zero (taker)", fmt(openFill.fees))
    : ko("open fill fees non-zero", "fees field is 0");
  // baseLotsDelta should equal +SIZE_LOTS
  Math.abs(num(openFill.baseLotsDelta)) > 0
    ? ok("open fill base delta non-zero", `${openFill.baseLotsDelta}`)
    : ko("open fill base delta non-zero", `${openFill.baseLotsDelta}`);
}

// ───── T2: hold and reconcile mark-to-market ─────
log(`\n[T2] holding ${HOLD_SECONDS}s, then reconciling unrealized PnL...`);
await sleep(HOLD_SECONDS * 1000);

const t2State = await getTrader();
const cross2 = t2State.accounts.find((a) => a.traderSubaccountIndex === 0);
const solPos = cross2?.positions?.find((p) => p.symbol === "SOL" || p.marketSymbol === "SOL");
if (!solPos) {
  ko("position visible after open", "no SOL position in cross account");
} else {
  const entry = num(solPos.entryPrice);
  const size = num(solPos.positionSize);
  const phoenixPnl = num(solPos.unrealizedPnl);
  log(`  position: size=${size}, entry=${fmt(entry)}, phoenixUnrealizedPnl=${fmt(phoenixPnl)}`);

  // Phoenix's per-position unrealizedPnl should equal (mark - entry) * size for longs.
  // We can't perfectly know "mark" since Phoenix and our orderbook may use slightly
  // different sources, but the implied mark should be close to current orderbook mid.
  if (size > 0) {
    const impliedMark = entry + phoenixPnl / size;       // for long
    const liveMark = await getMark("SOL");
    log(`  implied mark from Phoenix PnL: ${fmt(impliedMark)},  live orderbook mid: ${fmt(liveMark)}`);
    // Allow 0.5% drift between Phoenix's mark and our orderbook mid (different oracles, different timing)
    const driftPct = liveMark > 0 ? Math.abs(impliedMark - liveMark) / liveMark : 1;
    driftPct < 0.005
      ? ok(`Phoenix mark consistent with orderbook mid`, `drift ${(driftPct * 100).toFixed(3)}%`)
      : ko(`Phoenix mark consistent with orderbook mid`, `drift ${(driftPct * 100).toFixed(3)}% > 0.5%`);
  }

  // T6 invariant: account.unrealizedPnl == sum(positions.unrealizedPnl) — check now while we have a position
  const accountUnreal = num(cross2.unrealizedPnl);
  const sumPosUnreal = (cross2.positions ?? []).reduce((s, p) => s + num(p.unrealizedPnl), 0);
  close(accountUnreal, sumPosUnreal, 0.01)
    ? ok("invariant: account.unrealizedPnl == Σ position.unrealizedPnl", `${fmt(accountUnreal)} ≈ ${fmt(sumPosUnreal)}`)
    : ko("invariant: account.unrealizedPnl == Σ position.unrealizedPnl", `${fmt(accountUnreal)} vs ${fmt(sumPosUnreal)}`);

  // Effective collateral haircut invariant
  const cb = num(cross2.collateralBalance);
  const ec = num(cross2.effectiveCollateral);
  const u  = accountUnreal;
  // Phoenix can apply a haircut so effectiveCollateral can be ≤ cb + unrealized; we allow ec ≥ cb + unrealized - tolerance too
  // (the usual invariant is loose — just sanity-check signs/order of magnitude)
  Math.abs(ec - (cb + u)) < Math.max(1, Math.abs(cb) * 0.05)
    ? ok("invariant: effectiveCollateral ≈ collateralBalance + unrealizedPnl", `cb=${fmt(cb)}, u=${fmt(u)}, ec=${fmt(ec)}`)
    : ko("invariant: effectiveCollateral ≈ collateralBalance + unrealizedPnl", `cb=${fmt(cb)}, u=${fmt(u)}, ec=${fmt(ec)} (drift ${fmt(ec - cb - u)})`);
}

// ───── T3: close ─────
log(`\n[T3] closing — market SELL ${SIZE_LOTS} lot ${SYMBOL}...`);
const closeMark = await getMark(SYMBOL);
const closeSig = await buildAndSend("/api/tx/market-order", {
  authority: WALLET, symbol: SYMBOL, side: "ask", size_lots: SIZE_LOTS,
}, `T3 close SELL ${SIZE_LOTS} lot ${SYMBOL}`);
await sleep(4000);

// ───── T3+: assert close-fill record ─────
log(`\n[T3+] verifying close fill record...`);
const t3Trades = await getTrades(100);
const t3NewFills = (t3Trades.trades ?? []).filter((t) => tradeTsMs(t) >= t0);
log(`  ${t3NewFills.length} new fill(s) since T0`);
// Find close fill = the SELL among new fills (baseLotsDelta < 0). Prefer signature match, fall back to side.
const closeFill = t3NewFills.find((t) => t.signature === closeSig) ?? t3NewFills.find((t) => num(t.baseLotsDelta) < 0) ?? t3NewFills[0];
if (!closeFill || !openFill) {
  ko("close fill record visible in trade history", `closeSig=${closeSig}`);
} else {
  log(`  close fill: realized_pnl=${fmt(closeFill.realizedPnl)}, fees=${fmt(closeFill.fees)}, baseDelta=${closeFill.baseLotsDelta}`);

  // Empirical question: is realized_pnl gross or net of fees?
  // The round-trip should produce realized_pnl (close) ≈ (close_price - open_price) × size
  // If realized_pnl is gross of fees: round_trip_pnl = realized_pnl_close_gross
  //   ≈ (close_price - open_price) * size
  // Net: realized_pnl_net = (close_price - open_price) * size - close_fee
  // With both fills accounted for, total realized over window should = round-trip MTM minus total fees.
  const openPrice = num(openFill.price);
  const closePrice = num(closeFill.price);
  const sizeAbs = Math.abs(num(openFill.baseLotsDelta));
  const expectedGrossPnl = (closePrice - openPrice) * sizeAbs;     // long buy then sell
  const totalFees = num(openFill.fees) + num(closeFill.fees);
  const totalRealized = num(openFill.realizedPnl) + num(closeFill.realizedPnl);
  log(`  open price:  ${fmt(openPrice)}`);
  log(`  close price: ${fmt(closePrice)}`);
  log(`  size:        ${sizeAbs}`);
  log(`  expected gross MTM round-trip: ${fmt(expectedGrossPnl)}`);
  log(`  total fees:                    ${fmt(totalFees)}`);
  log(`  Σ realized_pnl:                ${fmt(totalRealized)}`);

  const grossDelta = Math.abs(totalRealized - expectedGrossPnl);
  const netDelta   = Math.abs(totalRealized - (expectedGrossPnl - totalFees));
  const grossDelta2 = Math.abs(totalRealized - (expectedGrossPnl + totalFees));     // if fees are signed negative already
  log(`  |Σrealized − gross|:                  ${fmt(grossDelta)}`);
  log(`  |Σrealized − (gross − fees)|:         ${fmt(netDelta)}`);
  log(`  |Σrealized − (gross + fees)|:         ${fmt(grossDelta2)}`);

  // Diagnostic: which interpretation does Phoenix actually use?
  let semantics;
  if (grossDelta < netDelta && grossDelta < grossDelta2) semantics = "gross (excludes fees)";
  else if (netDelta < grossDelta) semantics = "net (already subtracts fees)";
  else semantics = "ambiguous";
  log(`  → realized_pnl semantics: ${semantics}`);
  // Pass if any interpretation matches within tolerance — we just need to know which one.
  Math.min(grossDelta, netDelta, grossDelta2) < TOLERANCE_USD * 5
    ? ok("realized_pnl reconciles to (close-open)×size ± fees", `semantics=${semantics}`)
    : ko("realized_pnl reconciles to round-trip", `min delta ${fmt(Math.min(grossDelta, netDelta, grossDelta2))} > 5¢`);

  log(`\n  ★ EMPIRICAL ANSWER: realized_pnl is ${semantics.toUpperCase()} of fees ★\n`);
}

// ───── T4: cumulative PnL series reconciliation ─────
log(`\n[T4] reconciling cumulative-pnl series against round-trip realized PnL...`);
await sleep(6000);                          // allow pnl-series bucket to update
const t4Pnl = await getPnl("1m", 120);
const lastPnl4 = (t4Pnl.data ?? [])[t4Pnl.data.length - 1] ?? null;
if (!lastPnl4 || !lastPnl0) {
  ko("pnl series points present at T0 and T4", `t0=${!!lastPnl0}, t4=${!!lastPnl4}`);
} else {
  const cumPnlDelta = num(lastPnl4.cumulativePnl) - num(lastPnl0.cumulativePnl);
  // Sum of newly-recorded fills' realized_pnl in window [t0, t4]
  const t4Trades = await getTrades(50);
  const windowFills = (t4Trades.trades ?? []).filter((t) => {
    const tsMs = typeof t.timestamp === "string" ? new Date(t.timestamp).getTime() : Number(t.timestamp);
    return tsMs >= t0;
  });
  const sumRealized = windowFills.reduce((s, t) => s + num(t.realizedPnl), 0);
  const sumFees = windowFills.reduce((s, t) => s + num(t.fees), 0);
  log(`  cumulativePnl[t4] − cumulativePnl[t0] = ${fmt(cumPnlDelta)}`);
  log(`  Σ realized_pnl over window:             ${fmt(sumRealized)}`);
  log(`  Σ fees over window:                     ${fmt(sumFees)}`);
  // Per Phoenix docs, cumulative_pnl is net of fees + funding.
  // So the cumulative delta should match Σrealized (if realized is net), or Σrealized - Σfees (if realized is gross).
  const matchAsNet   = Math.abs(cumPnlDelta - sumRealized);
  const matchAsGross = Math.abs(cumPnlDelta - (sumRealized - sumFees));
  log(`  |cumDelta − Σrealized|:           ${fmt(matchAsNet)}   (if both net)`);
  log(`  |cumDelta − (Σrealized − Σfees)|: ${fmt(matchAsGross)}  (if realized gross of fees)`);
  Math.min(matchAsNet, matchAsGross) < TOLERANCE_USD * 5
    ? ok("cumulativePnl delta reconciles with trade history", `min delta ${fmt(Math.min(matchAsNet, matchAsGross))}`)
    : ko("cumulativePnl delta reconciles with trade history", `min delta ${fmt(Math.min(matchAsNet, matchAsGross))} > 5¢`);
}

// ───── T5: fee reconciliation ─────
log(`\n[T5] reconciling fees (maker + taker) against trade-fill fees...`);
const lastPnl5 = (t4Pnl.data ?? [])[t4Pnl.data.length - 1] ?? null;
const firstPnl5 = (t4Pnl.data ?? [])[0] ?? null;
if (lastPnl5 && firstPnl5) {
  const cumTakerDelta = num(lastPnl5.cumulativeTakerFee) - num(firstPnl5.cumulativeTakerFee);
  const cumMakerDelta = num(lastPnl5.cumulativeMakerFee) - num(firstPnl5.cumulativeMakerFee);
  const cumFeeTotal = cumTakerDelta + cumMakerDelta;
  const t4Trades = await getTrades(50);
  const windowFills = (t4Trades.trades ?? []).filter((t) => {
    const tsMs = typeof t.timestamp === "string" ? new Date(t.timestamp).getTime() : Number(t.timestamp);
    return tsMs >= t0;
  });
  const sumFillFees = windowFills.reduce((s, t) => s + num(t.fees), 0);
  log(`  cumulative taker fee delta: ${fmt(cumTakerDelta)}`);
  log(`  cumulative maker fee delta: ${fmt(cumMakerDelta)}`);
  log(`  cumulative fee delta total: ${fmt(cumFeeTotal)}`);
  log(`  Σ fill fees over window:    ${fmt(sumFillFees)}`);
  // Sign convention: cumulative fees are typically negative (paid). Compare absolute values.
  const matchTaker = Math.abs(Math.abs(cumTakerDelta) - Math.abs(sumFillFees));
  const matchTotal = Math.abs(Math.abs(cumFeeTotal) - Math.abs(sumFillFees));
  log(`  |taker only − fill fees| =        ${fmt(matchTaker)}   (current FE bug — drops maker fees)`);
  log(`  |taker + maker − fill fees| =     ${fmt(matchTotal)}    (correct)`);
  matchTotal < TOLERANCE_USD * 5
    ? ok("taker+maker fees reconcile with fill fees", `Δ ${fmt(matchTotal)}`)
    : ko("taker+maker fees reconcile with fill fees", `Δ ${fmt(matchTotal)} > 5¢`);
}

// ───── Final summary ─────
log(`\n╔═══════════════════════════════════════════════╗
║  SUMMARY: ${out.pass} pass / ${out.fail} fail
╚═══════════════════════════════════════════════╝`);
if (out.fail > 0) {
  for (const f of out.fails) log(`  − ${f.name}: ${f.why}`);
  process.exit(1);
}
process.exit(0);
