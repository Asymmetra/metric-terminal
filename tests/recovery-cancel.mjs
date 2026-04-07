import 'dotenv/config';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/test-wallet.json", "utf8"))));
const conn = new Connection(process.env.RPC_URL, "confirmed");
const WALLET = kp.publicKey.toBase58();
const BACKEND = "https://ember-backend-q4nf.onrender.com";

async function buildAndSend(endpoint, body, label) {
  console.log(`\n--- ${label} ---`);
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${BACKEND}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  const d = await res.json();
  console.log(`  HTTP ${res.status}: ${d.message || d.error || ("ixs=" + d.instructions?.length)}`);
  if (!d.instructions) return { ok: false, data: d };

  const ixs = d.instructions.map(ix => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  }));

  const { blockhash } = await conn.getLatestBlockhash();
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

  const sig = await conn.sendTransaction(tx);
  console.log(`  TX sent: ${sig}`);
  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf.value.err) {
    console.log(`  TX FAILED on-chain: ${JSON.stringify(conf.value.err)}`);
    return { ok: false, onChainErr: conf.value.err };
  }
  console.log(`  TX CONFIRMED ✓`);
  return { ok: true, sig };
}

// Step 0: Discover all stuck orders in sub=1 dynamically
const discoverRes = await fetch(`${BACKEND}/api/trader/${WALLET}`);
const discoverState = await discoverRes.json();
const sub1Acct = (discoverState.accounts || []).find(a => a.traderSubaccountIndex === 1);
const stuckOrders = sub1Acct?.limitOrders?.SOL || [];
console.log(`Sub=1 has ${stuckOrders.length} stuck SOL order(s)`);
stuckOrders.forEach(o => console.log(`  seq=${o.orderSequenceNumber} price=${o.price?.ui}`));

if (stuckOrders.length === 0) {
  console.log("Nothing to cancel — sub=1 is clean");
  process.exit(0);
}

// Step 1: Cancel all stuck orders in sub=1
const entries = stuckOrders.map(o => `{"price":${o.price?.ui ?? 1},"order_sequence_number":${o.orderSequenceNumber}}`);
const cancelBody = `{"authority":"${WALLET}","symbol":"SOL","subaccount_index":1,"order_ids":[${entries.join(",")}]}`;
const cancelResult = await buildAndSend("/api/tx/cancel-orders", cancelBody, `RECOVERY: Cancel ${stuckOrders.length} stuck SOL order(s) in sub=1`);

if (!cancelResult.ok) {
  console.log("RECOVERY CANCEL FAILED — aborting");
  process.exit(1);
}

// Verify order is gone
await new Promise(r => setTimeout(r, 2000));
const stateRes = await fetch(`${BACKEND}/api/trader/${WALLET}`);
const state = await stateRes.json();
const sub1 = (state.accounts || []).find(a => a.traderSubaccountIndex === 1);
const sub1Orders = sub1?.limitOrders?.SOL || [];
const sub1Bal = sub1?.collateralBalance?.ui || "0";
console.log(`\nPost-cancel sub=1: bal=${sub1Bal}, SOL orders=${sub1Orders.length}`);
if (sub1Orders.length > 0) {
  console.log("WARNING: order still on book after cancel");
}

// Step 2: Sweep sub=1 → cross
const sweepResult = await buildAndSend("/api/tx/transfer-collateral", {
  authority: WALLET,
  from_subaccount_index: 1,
  to_subaccount_index: 0,
}, "RECOVERY: Sweep sub=1 → cross");

// Step 3: Verify cross balance restored
await new Promise(r => setTimeout(r, 2000));
const finalRes = await fetch(`${BACKEND}/api/trader/${WALLET}`);
const finalState = await finalRes.json();
const cross = (finalState.accounts || []).find(a => a.traderSubaccountIndex === 0);
const iso1 = (finalState.accounts || []).find(a => a.traderSubaccountIndex === 1);
console.log(`\nFinal state:`);
console.log(`  Cross (sub=0): ${cross?.collateralBalance?.ui} USDC`);
console.log(`  Isolated (sub=1): ${iso1?.collateralBalance?.ui} USDC`);
console.log(`  Sub=1 SOL orders: ${(iso1?.limitOrders?.SOL || []).length}`);

const crossBal = parseFloat(cross?.collateralBalance?.ui || "0");
if (crossBal >= 20) {
  console.log(`\n✅ RECOVERY COMPLETE — cross=${crossBal} USDC, ready to run suite`);
} else {
  console.log(`\n⚠️  Cross balance ${crossBal} USDC — lower than expected. Check sub=1.`);
}
