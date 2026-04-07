/**
 * SKR smoke tests — Wave 5 addition
 * TEST 24: SKR isolated-limit-order (isolatedOnly market)
 * TEST 25: SKR cross-margin rejection check (informational — P3 guard may not be live)
 */
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/test-wallet.json", "utf8"))));
const conn = new Connection("https://asymmetr-solanam-0245.mainnet.rpcpool.com", "confirmed");
const WALLET = kp.publicKey.toBase58();
const BACKEND = "https://ember-backend-q4nf.onrender.com";

async function buildAndSend(endpoint, body, label) {
  console.log(`\n--- ${label} ---`);
  let res = await fetch(`${BACKEND}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  // Retry up to 3 times on 502 (cold Render instance)
  for (let retry = 1; retry <= 3 && res.status === 502; retry++) {
    const delay = retry * 3000;
    console.log(`  Got 502, retry ${retry}/3 after ${delay / 1000}s...`);
    await sleep(delay);
    const retryRes = await fetch(`${BACKEND}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const retryText = await retryRes.text();
    try { data = JSON.parse(retryText); } catch { data = { error: retryText }; }
    res = retryRes;
  }
  console.log(`  HTTP ${res.status}: ${data.message || data.error || "no message"}`);
  if (res.status !== 200 || !data.instructions) return { ok: false, status: res.status, data };

  const ixs = data.instructions.map(ix => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.log(`  SIM FAIL: ${JSON.stringify(sim.value.err)}`);
    sim.value.logs?.slice(-5).forEach(l => console.log(`    ${l}`));
    return { ok: false, simError: sim.value.err };
  }
  console.log(`  Simulation OK (${sim.value.unitsConsumed} CU)`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let currentSig, bh, lv;
    if (attempt === 1) {
      currentSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      bh = blockhash; lv = lastValidBlockHeight;
    } else {
      console.log(`  Retry ${attempt}/3: refreshing blockhash...`);
      const fresh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = fresh.blockhash; tx.sign([kp]);
      currentSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      bh = fresh.blockhash; lv = fresh.lastValidBlockHeight;
    }
    console.log(`  TX sent: ${currentSig}`);
    try {
      const conf = await conn.confirmTransaction({ signature: currentSig, blockhash: bh, lastValidBlockHeight: lv }, "confirmed");
      if (conf.value.err) { console.log(`  TX FAILED on-chain: ${JSON.stringify(conf.value.err)}`); return { ok: false, sig: currentSig, onChainErr: conf.value.err }; }
      console.log(`  TX CONFIRMED ✓`);
      return { ok: true, sig: currentSig, data };
    } catch (err) {
      if (err.name === 'TransactionExpiredBlockheightExceededError' && attempt < 3) { console.log(`  Block height expired, retrying...`); continue; }
      throw err;
    }
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  SKR SMOKE TESTS (Wave 5 addition)                     ║`);
console.log(`╚══════════════════════════════════════════════════════════╝`);
console.log(`Wallet: ${WALLET}`);
console.log(`Backend: ${BACKEND}`);

// Warmup: wake Render instance
console.log('\nWarming up backend...');
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const warmupRes = await fetch(`${BACKEND}/api/markets`);
    if (warmupRes.ok) { console.log(`Warmup OK (attempt ${attempt})`); break; }
    console.log(`Warmup attempt ${attempt}: HTTP ${warmupRes.status}`);
  } catch (e) {
    console.log(`Warmup attempt ${attempt}: ${e.message}`);
  }
  if (attempt < 3) await sleep(2000);
}

// =============================================================
// TEST 24: SKR isolated limit order (isolatedOnly, subaccount_index=1)
// Price $0.01 — guaranteed far from market
// =============================================================
console.log(`\n--- TEST 24: SKR isolated-limit-order (sub=1, price=$0.01, 1 USDC collateral) ---`);
const skrLimit = await buildAndSend("/api/tx/isolated-limit-order", {
  authority: WALLET,
  symbol: "SKR",
  side: "buy",
  price: 0.01,
  size_lots: 1,
  collateral_usdc: 1.0,
  subaccount_index: 1,
}, "TEST 24: SKR isolated limit buy @ $0.01");

if (skrLimit.ok) {
  const respSubIdx = skrLimit.data?.subaccount_index;
  console.log(`  ✅ TEST 24 PASS: sig=${skrLimit.sig}, response.subaccount_index=${respSubIdx}`);

  // Cancel the SKR order
  await sleep(2000);
  const stRes = await fetch(`${BACKEND}/api/trader/${WALLET}`);
  const st = await stRes.json();
  const sub1 = (st.accounts || []).find(a => a.traderSubaccountIndex === 1);
  const skrOrders = sub1?.limitOrders?.SKR || [];
  console.log(`  Sub=1 SKR orders found: ${skrOrders.length}`);

  if (skrOrders.length > 0) {
    const entries = skrOrders.map(o => `{"price":${o.price?.ui},"order_sequence_number":${o.orderSequenceNumber}}`);
    const cancelBody = `{"authority":"${WALLET}","symbol":"SKR","subaccount_index":1,"order_ids":[${entries.join(",")}]}`;
    const cancelResult = await buildAndSend("/api/tx/cancel-orders", cancelBody, "TEST 24 cleanup: cancel SKR order");
    if (cancelResult.ok) {
      console.log(`  Cancel PASS: sig=${cancelResult.sig}`);
    } else {
      console.log(`  Cancel FAIL: ${JSON.stringify(cancelResult.data || cancelResult.simError)}`);
    }

    // Sweep sub=1 → cross
    await sleep(1000);
    const sweepResult = await buildAndSend("/api/tx/transfer-collateral", {
      authority: WALLET,
      from_subaccount_index: 1,
      to_subaccount_index: 0,
    }, "TEST 24 cleanup: sweep sub=1→cross");
    if (sweepResult.ok) {
      console.log(`  Sweep PASS: sig=${sweepResult.sig}`);
    } else {
      console.log(`  Sweep FAIL (may be no collateral if cancel already settled it): ${JSON.stringify(sweepResult.data?.error || sweepResult.simError)}`);
    }
  }
} else {
  console.log(`  ❌ TEST 24 FAIL: HTTP ${skrLimit.status}: ${JSON.stringify(skrLimit.data)}`);
}

// =============================================================
// TEST 25: SKR cross-margin rejection (informational — P3 backend guard may not be live yet)
// =============================================================
await sleep(1000);
console.log(`\n--- TEST 25: SKR cross-margin rejection (informational only — P3 guard) ---`);
const skrCrossRes = await fetch(`${BACKEND}/api/tx/market-order`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ authority: WALLET, symbol: "SKR", side: "buy", size_lots: 1 }),
});
const skrCrossData = await skrCrossRes.json().catch(() => ({}));
console.log(`  HTTP ${skrCrossRes.status}: ${skrCrossData.message || skrCrossData.error || "no message"}`);
if (skrCrossRes.status === 400) {
  console.log(`  ✅ TEST 25: P3 guard LIVE — SKR cross-margin correctly rejected with HTTP 400`);
} else if (skrCrossRes.status === 200 && skrCrossData.instructions) {
  console.log(`  ⚠️  TEST 25: P3 guard NOT YET LIVE — SKR cross-margin returned HTTP 200 with instructions (known gap, Wave 8)`);
} else {
  console.log(`  ℹ️  TEST 25: HTTP ${skrCrossRes.status} — ${JSON.stringify(skrCrossData).slice(0, 200)}`);
}

console.log(`\nSKR SMOKE DONE`);
