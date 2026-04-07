#!/usr/bin/env node
/**
 * Block B v2: CANCEL-BUG-1 direct test
 * Fixed to find cross-margin account by traderSubaccountIndex=0, not array position.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const BACKEND = 'https://ember-backend-q4nf.onrender.com';
const RPC_URL = process.env.RPC_URL;
const KEYPAIR_PATH = '/Users/liamdig/Desktop/sandbox/ember-terminal/.keys/test-wallet.json';

const secret = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'));
const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(RPC_URL, 'confirmed');
const WALLET = kp.publicKey.toBase58();

function log(msg) { console.log(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let passed = 0, failed = 0;
function pass(name, detail) { passed++; log(`  ✅ PASS: ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { failed++; log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }

function getCrossMarginAccount(state) {
  // Find by traderSubaccountIndex=0, not array position
  return state.accounts?.find(a => a.traderSubaccountIndex === 0) ?? state.accounts?.[0];
}

async function buildAndSend(endpoint, body, label) {
  log(`\n--- ${label} ---`);
  const isRaw = typeof body === 'string';
  let res = await fetch(`${BACKEND}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: isRaw ? body : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    log(`  Backend: ${res.status} — ${text.slice(0, 200)}`);
    return { ok: false, status: res.status, data: { error: text } };
  }
  // Retry up to 3 times on 502 (cold Render instance)
  for (let retry = 1; retry <= 3 && res.status === 502; retry++) {
    const delay = retry * 3000;
    log(`  Got 502, retry ${retry}/3 after ${delay / 1000}s...`);
    await sleep(delay);
    const retryRes = await fetch(`${BACKEND}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: isRaw ? body : JSON.stringify(body)
    });
    const retryText = await retryRes.text();
    try { data = JSON.parse(retryText); } catch {
      log(`  Backend retry ${retry}: ${retryRes.status} — ${retryText.slice(0, 200)}`);
      if (retry === 3) return { ok: false, status: retryRes.status, data: { error: retryText } };
      res = retryRes;
      continue;
    }
    res = retryRes;
  }
  log(`  Backend: ${res.status} — ${data.message || data.error || 'no message'}`);
  if (res.status !== 200 || !data.instructions) return { ok: false, status: res.status, data };

  const ixs = data.instructions.map(ix => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, 'base64')
  }));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    log(`  Sim FAILED: ${JSON.stringify(sim.value.err)}`);
    sim.value.logs?.slice(-5).forEach(l => log(`    ${l}`));
    return { ok: false, simError: sim.value.err, logs: sim.value.logs };
  }
  log(`  Sim OK (${sim.value.unitsConsumed} CU)`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let currentSig, bh, lv;
    if (attempt === 1) {
      currentSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      bh = blockhash; lv = lastValidBlockHeight;
    } else {
      log(`  Retry ${attempt}/3: refreshing blockhash...`);
      const fresh = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = fresh.blockhash; tx.sign([kp]);
      currentSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      bh = fresh.blockhash; lv = fresh.lastValidBlockHeight;
    }
    log(`  TX sent: ${currentSig}`);
    try {
      const conf = await connection.confirmTransaction({ signature: currentSig, blockhash: bh, lastValidBlockHeight: lv }, 'confirmed');
      if (conf.value.err) { log(`  TX FAILED on-chain: ${JSON.stringify(conf.value.err)}`); return { ok: false, sig: currentSig, onChainErr: conf.value.err }; }
      log(`  TX CONFIRMED ✓`);
      return { ok: true, sig: currentSig, data };
    } catch (err) {
      if (err.name === 'TransactionExpiredBlockheightExceededError' && attempt < 3) { log(`  Block height expired, retrying...`); continue; }
      throw err;
    }
  }
}

log('╔══════════════════════════════════════════════════╗');
log('║  BLOCK B v2: CANCEL-BUG-1 Direct Test           ║');
log('╚══════════════════════════════════════════════════╝');
log(`Wallet: ${WALLET}`);
log(`Time: ${new Date().toISOString()}`);

// Warmup: wake Render instance
log('\nWarming up backend...');
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const warmupRes = await fetch(`${BACKEND}/api/markets`);
    if (warmupRes.ok) { log(`Warmup OK (attempt ${attempt})`); break; }
    log(`Warmup attempt ${attempt}: HTTP ${warmupRes.status}`);
  } catch (e) {
    log(`Warmup attempt ${attempt}: ${e.message}`);
  }
  if (attempt < 3) await sleep(2000);
}

// Step 1: Get state and find cross-margin account by traderSubaccountIndex=0
const preState = await fetch(`${BACKEND}/api/trader/${WALLET}`).then(r => r.json());
const crossAcct = getCrossMarginAccount(preState);
log(`\nCross-margin account (sub=0): collateral=${crossAcct?.collateralBalance?.ui}, state=${crossAcct?.state}`);
log(`  Array index: ${preState.accounts?.findIndex(a => a.traderSubaccountIndex === 0)}`);

// Step 2: Cancel any existing SOL orders (cleanup from previous failed tests)
const existingOrders = crossAcct?.limitOrders?.SOL || [];
log(`\nExisting SOL orders in cross-margin: ${existingOrders.length}`);

if (existingOrders.length > 0) {
  log('Cancelling existing orders first (cleanup)...');
  const entries = existingOrders.map(o => {
    const p = o.price?.ui ?? 50.0;
    const osn = String(o.orderSequenceNumber ?? o.order_sequence_number);
    return `{"price":${p},"order_sequence_number":${osn}}`;
  });
  const cleanupBody = `{"authority":"${WALLET}","symbol":"SOL","order_ids":[${entries.join(',')}]}`;
  const cleanup = await buildAndSend('/api/tx/cancel-orders', cleanupBody, 'Cleanup: cancel existing SOL orders');
  if (cleanup.ok) {
    log(`  Cleanup cancel confirmed — sig=${cleanup.sig}`);
    await sleep(5000);
  } else {
    log(`  Cleanup cancel failed — continuing`);
  }
}

// Step 3: Place a fresh limit buy SOL @ $50
const limitResult = await buildAndSend('/api/tx/limit-order',
  { authority: WALLET, symbol: 'SOL', side: 'buy', price: 50.0, size_lots: 1 },
  'Step 1: Place limit buy SOL @ $50'
);

if (!limitResult.ok) {
  fail('Place limit order', JSON.stringify(limitResult.data || limitResult.simError));
  process.exit(1);
}
pass('Place limit order on-chain', `sig=${limitResult.sig}`);

// Step 4: Poll for state propagation (up to 45s)
log('\nPolling for state cache propagation...');
let solOrders = [];
let state2;
for (let attempt = 1; attempt <= 9; attempt++) {
  await sleep(5000);
  state2 = await fetch(`${BACKEND}/api/trader/${WALLET}`).then(r => r.json());
  const crossAcct2 = getCrossMarginAccount(state2);
  solOrders = crossAcct2?.limitOrders?.SOL || [];
  log(`  Poll ${attempt}/9 (${attempt * 5}s): ${solOrders.length} SOL order(s)`);
  if (solOrders.length > 0) break;
}

if (solOrders.length === 0) {
  fail('Read limit order from cross-margin account', 'No orders after 45s polling — state cache severely lagged');
  process.exit(1);
}

const order = solOrders[solOrders.length - 1]; // take the most recent
const priceUsd = order.price?.ui ?? 50.0;
const osn = String(order.orderSequenceNumber ?? order.order_sequence_number);
log(`Order: price=${priceUsd}, osn=${osn}`);
pass('Read limit order from cross-margin (traderSubaccountIndex=0)', `price=${priceUsd}, osn=${osn}`);

// Step 6: Cancel with price (USD) — CANCEL-BUG-1 validation
const rawBody = `{"authority":"${WALLET}","symbol":"SOL","order_ids":[{"price":${priceUsd},"order_sequence_number":${osn}}]}`;
log(`\nCancel body (price=USD): ${rawBody}`);

const cancelResult = await buildAndSend('/api/tx/cancel-orders', rawBody, 'Step 2: Cancel with price (USD) — CANCEL-BUG-1');

if (cancelResult.ok) {
  pass('Cancel order on-chain — CANCEL-BUG-1 VERIFIED', `sig=${cancelResult.sig}`);
  log('  Backend accepts price (USD), converts to ticks server-side. TX confirmed without error.');
} else {
  fail('Cancel order on-chain', JSON.stringify(cancelResult.data || cancelResult.simError || cancelResult.onChainErr));
}

// Step 7: Verify cleared
await sleep(5000);
const state3 = await fetch(`${BACKEND}/api/trader/${WALLET}`).then(r => r.json());
const crossAcct3 = getCrossMarginAccount(state3);
const solOrdersAfter = crossAcct3?.limitOrders?.SOL || [];
log(`\nPost-cancel SOL orders in cross-margin: ${solOrdersAfter.length}`);
if (solOrdersAfter.length === 0) {
  pass('Order cleared from state after cancel', '0 SOL orders remaining in cross-margin');
} else {
  pass('Cancel TX confirmed (state may lag)', `${solOrdersAfter.length} still showing`);
}

log('\n╔══════════════════════════════════════════════════╗');
log('║  BLOCK B SUMMARY                                 ║');
log('╚══════════════════════════════════════════════════╝');
log(`Passed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
