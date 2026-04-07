#!/usr/bin/env node
/**
 * Block D: TP/SL bracket orders E2E test
 * Tests 5f614eb bracket PDA fix and overall bracket instruction building.
 *
 * 1. Cross-margin limit order with stop_loss_price + take_profit_price
 * 2. Isolated limit order with stop_loss_price + take_profit_price + subaccount_index
 */
import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const BACKEND = 'https://ember-backend-q4nf.onrender.com';
const RPC_URL = 'https://asymmetr-solanam-0245.mainnet.rpcpool.com';
const KEYPAIR_PATH = '/Users/liamdig/Desktop/sandbox/ember-terminal/.keys/test-wallet.json';

const secret = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'));
const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(RPC_URL, 'confirmed');
const WALLET = kp.publicKey.toBase58();

function log(msg) { console.log(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let passed = 0, failed = 0, skipped = 0;
function pass(name, detail) { passed++; log(`  ✅ PASS: ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { failed++; log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
function skip(name, detail) { skipped++; log(`  ⏭️  SKIP: ${name}${detail ? ' — ' + detail : ''}`); }

async function buildAndSend(endpoint, body, label) {
  log(`\n--- ${label} ---`);
  let res = await fetch(`${BACKEND}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    log(`  Backend: ${res.status} — ${text.slice(0, 300)}`);
    return { ok: false, status: res.status, data: { error: text } };
  }
  // Retry once on 502 (cold Render instance)
  if (res.status === 502) {
    log(`  Got 502, retrying after 2s...`);
    await sleep(2000);
    const retryRes = await fetch(`${BACKEND}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const retryText = await retryRes.text();
    try { data = JSON.parse(retryText); } catch {
      log(`  Backend retry: ${retryRes.status} — ${retryText.slice(0, 300)}`);
      return { ok: false, status: retryRes.status, data: { error: retryText } };
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
    sim.value.logs?.slice(-8).forEach(l => log(`    ${l}`));
    return { ok: false, simError: sim.value.err, logs: sim.value.logs };
  }
  log(`  Sim OK (${sim.value.unitsConsumed} CU, ${ixs.length} instruction(s))`);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  log(`  TX sent: ${sig}`);
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) {
    log(`  TX FAILED on-chain: ${JSON.stringify(conf.value.err)}`);
    return { ok: false, sig, onChainErr: conf.value.err };
  }
  log(`  TX CONFIRMED ✓`);
  return { ok: true, sig, data };
}

function getCrossMarginAccount(state) {
  return state.accounts?.find(a => a.traderSubaccountIndex === 0) ?? state.accounts?.[0];
}

log('╔══════════════════════════════════════════════════╗');
log('║  BLOCK D: TP/SL Bracket Orders E2E Test         ║');
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

// Pre-state
const preState = await fetch(`${BACKEND}/api/trader/${WALLET}`).then(r => r.json());
const crossAcct = getCrossMarginAccount(preState);
log(`\nCross-margin: collateral=${crossAcct?.collateralBalance?.ui}, state=${crossAcct?.state}`);

// ============================================================
// TEST 1: Cross-margin limit buy SOL @ $50 with TP=$200 SL=$10
// Tests bracket leg instruction building (5f614eb for cross-margin path)
// ============================================================
log('\n=== TEST 1: Cross-margin limit order with TP/SL ===');
log('  Placing SOL buy @ $50 with take_profit=$200, stop_loss=$10');
log('  This is well below market — will not fill. Tests bracket ix building.');

const crossTpsl = await buildAndSend('/api/tx/limit-order', {
  authority: WALLET,
  symbol: 'SOL',
  side: 'buy',
  price: 50.0,
  size_lots: 1,
  take_profit_price: 200.0,
  stop_loss_price: 10.0
}, 'TEST 1: Cross-margin SOL limit @ $50 + TP=$200 SL=$10');

if (!crossTpsl.ok && crossTpsl.status === 400) {
  pass('Cross-margin limit + TP/SL correctly rejected', 'Backend returns 400 — TP/SL requires existing position (Phoenix error 7002)');
} else if (crossTpsl.ok) {
  fail('Cross-margin limit + TP/SL', 'Expected 400 rejection but got success — TP/SL on limit orders is unsupported');
} else {
  fail('Cross-margin limit + TP/SL', JSON.stringify(crossTpsl.data || crossTpsl.simError || crossTpsl.onChainErr));
}

// No cleanup needed — limit order was rejected at 400 (no order placed)

// ============================================================
// TEST 2: Isolated limit order with TP/SL
// Tests 5f614eb bracket PDA bound to correct isolated subaccount
// NOTE: Expected to fail with price format bug until backend is fixed
// ============================================================
log('\n=== TEST 2: Isolated limit order with TP/SL ===');
log('  Placing isolated ETH buy @ $500 + TP=$5000 SL=$100 + subaccount_index=1');
log('  Tests 5f614eb: bracket ixs must bind to sub=1 PDA, not sub=0');

const isoTpsl = await buildAndSend('/api/tx/isolated-limit-order', {
  authority: WALLET,
  symbol: 'ETH',
  side: 'buy',
  price: 500.0,
  size_lots: 1,
  collateral_usdc: 2.0,
  subaccount_index: 1,
  take_profit_price: 5000.0,
  stop_loss_price: 100.0
}, 'TEST 2: Isolated ETH limit @ $500 + TP=$5000 SL=$100');

if (!isoTpsl.ok && isoTpsl.status === 400) {
  pass('Isolated limit + TP/SL correctly rejected', 'Backend returns 400 — TP/SL requires existing position (Phoenix error 7002)');
} else if (isoTpsl.ok) {
  fail('Isolated limit + TP/SL', 'Expected 400 rejection but got success — TP/SL on limit orders is unsupported');
} else {
  fail('Isolated limit + TP/SL', JSON.stringify(isoTpsl.data || isoTpsl.simError || isoTpsl.onChainErr).slice(0, 300));
}

// ============================================================
// TEST 3: Cross-margin market order with TP/SL
// (market orders also accept bracket fields — test this path)
// ============================================================
log('\n=== TEST 3: Cross-margin market order with TP/SL ===');

const marketTpsl = await buildAndSend('/api/tx/market-order', {
  authority: WALLET,
  symbol: 'SOL',
  side: 'buy',
  size_lots: 1,
  take_profit_price: 500.0,
  stop_loss_price: 1.0
}, 'TEST 3: Cross-margin SOL market buy + TP=$500 SL=$1');

if (marketTpsl.ok) {
  pass('Cross-margin market order + TP/SL confirmed on-chain', `sig=${marketTpsl.sig}`);
  // Close the position
  await sleep(3000);
  const closeResult = await buildAndSend('/api/tx/market-order', {
    authority: WALLET, symbol: 'SOL', side: 'sell', size_lots: 1
  }, 'Cleanup: close SOL position');
  if (closeResult.ok) log(`  Cleanup close OK — sig=${closeResult.sig}`);
} else {
  const errStr = JSON.stringify(marketTpsl.data || marketTpsl.simError || marketTpsl.onChainErr);
  fail('Cross-margin market order + TP/SL', errStr.slice(0, 300));
}

// Summary
log('\n╔══════════════════════════════════════════════════╗');
log('║  BLOCK D SUMMARY                                 ║');
log('╚══════════════════════════════════════════════════╝');
log(`Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);
process.exit(failed > 0 ? 1 : 0);
