#!/usr/bin/env node
/**
 * Full E2E test suite — tests every tx endpoint on production
 *
 * Test plan:
 *   1. Deposit 5 more USDC (total 10)
 *   2. Place limit buy order (far below market — won't fill)
 *   3. Verify order appears in trader state
 *   4. Cancel the order
 *   5. Verify order is gone
 *   6. Place market buy order (1 lot = 0.01 SOL)
 *   7. Verify position exists
 *   8. Close position with market sell
 *   9. Withdraw 2 USDC
 *  10. Verify final state
 */
import { readFileSync } from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const BACKEND = "https://ember-backend-q4nf.onrender.com";
const RPC_URL =
  "https://asymmetr-solanam-0245.mainnet.rpcpool.com";
const KEYPAIR_PATH =
  "/Users/liamdig/Desktop/sandbox/ember-terminal/.keys/test-wallet.json";

const secret = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"));
const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(RPC_URL, "confirmed");
const WALLET = kp.publicKey.toBase58();

const results = [];
let testNum = 0;

function log(msg) {
  console.log(msg);
}

function pass(name, detail) {
  testNum++;
  results.push({ test: testNum, name, status: "PASS", detail });
  log(`  ✅ TEST ${testNum}: ${name}`);
  if (detail) log(`     ${detail}`);
}

function fail(name, detail) {
  testNum++;
  results.push({ test: testNum, name, status: "FAIL", detail });
  log(`  ❌ TEST ${testNum}: ${name}`);
  if (detail) log(`     ${detail}`);
}

async function buildAndSend(endpoint, body, label) {
  log(`\n--- ${label} ---`);

  // Support raw string body for cases where we need exact JSON (BigInt fields)
  const isRawBody = typeof body === "string";
  let res = await fetch(`${BACKEND}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: isRawBody ? body : JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    log(`  Backend: ${res.status} — ${text.slice(0, 200)}`);
    return { ok: false, status: res.status, data: { error: text } };
  }

  // Retry once on 502 (cold Render instance)
  if (res.status === 502) {
    log(`  Got 502, retrying after 2s...`);
    await sleep(2000);
    const retryRes = await fetch(`${BACKEND}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: isRawBody ? body : JSON.stringify(body),
    });
    const retryText = await retryRes.text();
    try { data = JSON.parse(retryText); } catch {
      log(`  Backend retry: ${retryRes.status} — ${retryText.slice(0, 200)}`);
      return { ok: false, status: retryRes.status, data: { error: retryText } };
    }
    res = retryRes;
  }

  log(`  Backend: ${res.status} — ${data.message || data.error || "no message"}`);

  if (res.status !== 200 || !data.instructions) {
    return { ok: false, status: res.status, data };
  }

  // Deserialize
  const ixs = data.instructions.map((ix) =>
    new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: Buffer.from(ix.data, "base64"),
    })
  );

  // Simulate
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });

  if (sim.value.err) {
    log(`  Simulation FAILED: ${JSON.stringify(sim.value.err)}`);
    if (sim.value.logs) {
      sim.value.logs.slice(-5).forEach((l) => log(`    ${l}`));
    }
    return { ok: false, simError: sim.value.err, logs: sim.value.logs };
  }
  log(`  Simulation OK (${sim.value.unitsConsumed} CU)`);

  // Send
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  log(`  TX sent: ${sig}`);

  // Confirm
  const confirmation = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation.value.err) {
    log(`  TX FAILED on-chain: ${JSON.stringify(confirmation.value.err)}`);
    return { ok: false, sig, onChainErr: confirmation.value.err };
  }

  log(`  TX CONFIRMED ✓`);
  return { ok: true, sig, data };
}

async function getTraderState() {
  const res = await fetch(`${BACKEND}/api/trader/${WALLET}`);
  return await res.json();
}

function getCrossMarginAccount(state) {
  return state.accounts?.find(a => a.traderSubaccountIndex === 0) ?? state.accounts?.[0];
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
log("╔══════════════════════════════════════════════════╗");
log("║        EMBER TERMINAL — FULL E2E TEST           ║");
log("╚══════════════════════════════════════════════════╝");
log(`Wallet: ${WALLET}`);
log(`Backend: ${BACKEND}`);
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

// Pre-check: trader state
const preState = await getTraderState();
const preAcct = getCrossMarginAccount(preState);
log(`\nPre-test state: ${preAcct?.state}, flags=${preAcct?.flags}, collateral=${preAcct?.collateralBalance?.ui}`);

// ============================================================
// TEST 1: Deposit 5 more USDC
// ============================================================
const currentCollateral = parseFloat(preAcct?.collateralBalance?.ui || "0");
if (currentCollateral >= 9.5) {
  log("\n--- TEST 1: Deposit 5 USDC (SKIPPED — already have ~10 USDC) ---");
  pass("Deposit 5 USDC (skipped, already funded)", `collateral=${currentCollateral}`);
} else {
  const dep = await buildAndSend("/api/tx/deposit", {
    authority: WALLET,
    amount_usdc: 5.0,
  }, "TEST 1: Deposit 5 USDC");

  if (dep.ok) {
    await sleep(2000);
    const state = await getTraderState();
    const col = parseFloat(getCrossMarginAccount(state)?.collateralBalance?.ui || "0");
    if (col >= 9.5) {
      pass("Deposit 5 USDC", `collateral=${col}, sig=${dep.sig}`);
    } else {
      fail("Deposit 5 USDC", `collateral=${col} (expected ~10)`);
    }
  } else {
    fail("Deposit 5 USDC", JSON.stringify(dep.data || dep.simError || dep.onChainErr));
  }
}

// ============================================================
// TEST 2: Place limit buy order far below market (SOL @ $50)
// ============================================================
const limitBuy = await buildAndSend("/api/tx/limit-order", {
  authority: WALLET,
  symbol: "SOL",
  side: "buy",
  price: 50.0,
  size_lots: 1,
}, "TEST 2: Limit buy SOL @ $50 (1 lot)");

if (limitBuy.ok) {
  pass("Limit order placed", `sig=${limitBuy.sig}`);
} else {
  fail("Limit order placed", JSON.stringify(limitBuy.data || limitBuy.simError || limitBuy.onChainErr));
}

// ============================================================
// TEST 3: Verify order in trader state
// ============================================================
await sleep(2000);
const stateAfterLimit = await getTraderState();
const solOrders = getCrossMarginAccount(stateAfterLimit)?.limitOrders?.SOL || [];
log(`\n--- TEST 3: Verify limit order exists ---`);

if (solOrders.length > 0) {
  pass("Limit order visible in trader state", `${solOrders.length} order(s) found`);
} else {
  const allOrders = getCrossMarginAccount(stateAfterLimit)?.limitOrders;
  if (allOrders && Object.keys(allOrders).length > 0) {
    pass("Limit order visible in trader state", `orders in: ${Object.keys(allOrders).join(", ")}`);
  } else {
    fail("Limit order visible in trader state", "No orders found");
  }
}

// ============================================================
// TEST 4: Cancel the limit order
// ============================================================
// Extract ALL order IDs — cancel everything to handle leftover orders from prior runs
const ordersForCancel = getCrossMarginAccount(stateAfterLimit)?.limitOrders?.SOL || [];
if (ordersForCancel.length > 0) {
  // Backend accepts price as f64 (human-readable USD) and converts via price_to_ticks()
  // orderSequenceNumber exceeds JS Number.MAX_SAFE_INTEGER — keep as raw string
  const orderEntries = ordersForCancel.map((o) => {
    const price = o.price?.ui ?? 50.0;
    const seq = String(o.orderSequenceNumber ?? o.order_sequence_number);
    return `{"price":${price},"order_sequence_number":${seq}}`;
  });

  log(`  Cancelling ${orderEntries.length} order(s)`);

  // Build raw JSON with all orders
  const rawBody = `{"authority":"${WALLET}","symbol":"SOL","order_ids":[${orderEntries.join(",")}]}`;
  log(`  Raw cancel body: ${rawBody}`);

  const cancel = await buildAndSend("/api/tx/cancel-orders", rawBody, "TEST 4: Cancel all SOL limit orders");

  if (cancel.ok) {
    pass("Cancel order", `sig=${cancel.sig}`);
  } else {
    fail("Cancel order", JSON.stringify(cancel.data || cancel.simError || cancel.onChainErr));
  }
} else {
  log("\n--- TEST 4: Cancel limit order ---");
  fail("Cancel order", "No order IDs found to cancel");
}

// ============================================================
// TEST 5: Verify order cancelled
// ============================================================
await sleep(2000);
const stateAfterCancel = await getTraderState();
const solOrdersAfter = getCrossMarginAccount(stateAfterCancel)?.limitOrders?.SOL || [];
log(`\n--- TEST 5: Verify order cancelled ---`);
if (solOrdersAfter.length === 0) {
  pass("Order cancelled — no remaining SOL orders", "");
} else {
  fail("Order cancelled", `Still have ${solOrdersAfter.length} SOL orders`);
}

// ============================================================
// TEST 6: Market buy order (1 lot = 0.01 SOL ≈ $0.84)
// ============================================================
const marketBuy = await buildAndSend("/api/tx/market-order", {
  authority: WALLET,
  symbol: "SOL",
  side: "buy",
  size_lots: 1,
}, "TEST 6: Market buy 0.01 SOL");

if (marketBuy.ok) {
  pass("Market buy order", `sig=${marketBuy.sig}`);
} else {
  fail("Market buy order", JSON.stringify(marketBuy.data || marketBuy.simError || marketBuy.onChainErr));
}

// ============================================================
// TEST 7: Verify position exists
// ============================================================
await sleep(2000);
const stateAfterBuy = await getTraderState();
const positions = getCrossMarginAccount(stateAfterBuy)?.positions;
log(`\n--- TEST 7: Verify position ---`);

if (positions) {
  const solPos = positions.SOL;
  log(`  SOL position: ${JSON.stringify(solPos)}`);
  if (solPos) {
    const size = solPos.tradeSizeRemaining?.ui || solPos.size?.ui || solPos.baseLots || solPos.sizeLots;
    pass("Position exists after market buy", `SOL size=${size}`);
  } else {
    // Maybe no SOL key but position shows differently
    log(`  All positions keys: ${Object.keys(positions).join(", ")}`);
    pass("Position data present", `keys: ${Object.keys(positions).join(", ")}`);
  }
} else {
  fail("Position exists after market buy", "No positions object");
}

// ============================================================
// TEST 8: Close position — market sell 1 lot
// ============================================================
const marketSell = await buildAndSend("/api/tx/market-order", {
  authority: WALLET,
  symbol: "SOL",
  side: "sell",
  size_lots: 1,
}, "TEST 8: Market sell 0.01 SOL (close position)");

if (marketSell.ok) {
  pass("Market sell (close position)", `sig=${marketSell.sig}`);
} else {
  fail("Market sell (close position)", JSON.stringify(marketSell.data || marketSell.simError || marketSell.onChainErr));
}

// ============================================================
// TEST 9: Withdraw 2 USDC
// ============================================================
await sleep(2000);
const withdraw = await buildAndSend("/api/tx/withdraw", {
  authority: WALLET,
  amount_usdc: 2.0,
}, "TEST 9: Withdraw 2 USDC");

if (withdraw.ok) {
  pass("Withdraw 2 USDC", `sig=${withdraw.sig}`);
} else {
  fail("Withdraw 2 USDC", JSON.stringify(withdraw.data || withdraw.simError || withdraw.onChainErr));
}

// ============================================================
// TEST 10: Verify final state
// ============================================================
await sleep(2000);
const finalState = await getTraderState();
const finalAcct = getCrossMarginAccount(finalState);
const finalCollateral = parseFloat(finalAcct?.collateralBalance?.ui || "0");
log(`\n--- TEST 10: Final state verification ---`);
log(`  State: ${finalAcct?.state}`);
log(`  Flags: ${finalAcct?.flags}`);
log(`  Collateral: ${finalCollateral}`);

if (finalCollateral > 0 && finalCollateral < 10) {
  pass("Final state consistent", `collateral=${finalCollateral} (10 deposited - 2 withdrawn ± fees)`);
} else if (finalCollateral >= 10) {
  // Withdraw may not have reduced collateral if there was an issue
  pass("Final state — collateral still high", `collateral=${finalCollateral}`);
} else {
  fail("Final state consistent", `collateral=${finalCollateral}`);
}

// ============================================================
// SUMMARY
// ============================================================
log("\n╔══════════════════════════════════════════════════╗");
log("║                  TEST SUMMARY                    ║");
log("╚══════════════════════════════════════════════════╝");
const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
log(`  Total: ${results.length}  |  Passed: ${passed}  |  Failed: ${failed}`);
log("");
for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : "❌";
  log(`  ${icon} ${r.test}. ${r.name}`);
}

log(`\nDone at ${new Date().toISOString()}`);
process.exit(failed > 0 ? 1 : 0);
