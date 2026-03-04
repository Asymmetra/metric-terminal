#!/usr/bin/env node
// DEPRECATED — does not verify on-chain confirmation (confirmation.value.err not checked).
// This script produced false PASS results — TXs appeared confirmed but failed on-chain.
// Use e2e-full.mjs instead.
/**
 * Ember Terminal — E2E Live Test Script
 *
 * Tests the full transaction pipeline programmatically:
 *   1. Deposit USDC → sign → submit → verify
 *   2. Market order (bid) → sign → submit → verify position
 *   3. Close position (ask) → sign → submit → verify
 *   4. Limit order → sign → submit → verify
 *   5. Cancel limit order → sign → submit → verify
 *   6. Withdraw → sign → submit → verify
 *
 * Usage: node tests/e2e-live.mjs
 *
 * Requires: npm install @solana/web3.js ws
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BACKEND = "https://ember-backend-q4nf.onrender.com";
const WS_URL = "wss://ember-backend-q4nf.onrender.com/ws";
const RPC_URL =
  "https://asymmetr-solanam-0245.mainnet.rpcpool.com";
const KEYPAIR_PATH =
  "/Users/liamdig/Desktop/sandbox/ember-terminal/.keys/test-wallet.json";

// Test parameters — small amounts to minimize risk
const DEPOSIT_USDC = 1.0;     // $1 USDC
const WITHDRAW_USDC = 1.0;    // $1 USDC
const MARKET_SYMBOL = "SOL";  // Backend uses bare symbols (no -PERP suffix)
const MARKET_SIZE_LOTS = 1;   // Minimum lot size
const LIMIT_PRICE = 50.0;     // Far below market — won't fill, easy to cancel
const LIMIT_SIZE_LOTS = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const results = [];

function log(msg) {
  console.log(`[E2E] ${msg}`);
}

function record(step, status, txSig, detail) {
  results.push({ step, status, txSig: txSig || "—", detail: detail || "" });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";
  log(`${icon} ${step}: ${status}${txSig ? ` | TX: ${txSig}` : ""}${detail ? ` | ${detail}` : ""}`);
}

async function api(method, path, body) {
  const url = `${BACKEND}${path}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

function deserializeInstructions(serialized) {
  return serialized.map((ix) => {
    return new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: Buffer.from(ix.data, "base64"),
    });
  });
}

async function buildSignSubmit(connection, keypair, instructions) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([keypair]);

  // Simulate first
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    const logs = sim.value.logs?.join("\n") || "No logs";
    throw new Error(
      `Simulation failed: ${JSON.stringify(sim.value.err)}\n${logs}`
    );
  }

  const txSig = await connection.sendTransaction(tx, { skipPreflight: true });

  // Confirm
  await connection.confirmTransaction(
    { signature: txSig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  return txSig;
}

// ---------------------------------------------------------------------------
// Test Steps
// ---------------------------------------------------------------------------

async function testGetEndpoints() {
  log("--- Phase 1: GET Endpoint Tests ---");

  // Health
  const health = await api("GET", "/health");
  record("GET /health", health.status === 200 ? "PASS" : "FAIL", null,
    `HTTP ${health.status} | body: ${health.text.trim()}`);

  // Markets
  const markets = await api("GET", "/api/markets");
  const numMarkets = markets.json?.length || 0;
  record("GET /api/markets", markets.ok && numMarkets > 0 ? "PASS" : "FAIL", null,
    `HTTP ${markets.status} | ${numMarkets} markets: ${(markets.json || []).map(m => m.symbol).join(", ")}`);

  // Orderbook
  const ob = await api("GET", `/api/orderbook/${MARKET_SYMBOL}`);
  const numBids = ob.json?.bids?.length || 0;
  const numAsks = ob.json?.asks?.length || 0;
  record("GET /api/orderbook/SOL", ob.ok ? "PASS" : "FAIL", null,
    `HTTP ${ob.status} | ${numBids} bids, ${numAsks} asks`);

  // Candles
  const candles = await api("GET", `/api/candles/${MARKET_SYMBOL}?resolution=60`);
  const numCandles = Array.isArray(candles.json) ? candles.json.length : 0;
  record("GET /api/candles/SOL", candles.ok && numCandles > 0 ? "PASS" : "FAIL", null,
    `HTTP ${candles.status} | ${numCandles} candles`);

  // Trader (may 502 if wallet not yet registered — expected for fresh wallets)
  const trader = await api("GET", `/api/trader/${keypair.publicKey.toBase58()}`);
  const traderExpected = trader.ok || (trader.status === 502 && trader.text.includes("not found"));
  record("GET /api/trader/:pubkey", traderExpected ? "PASS" : "FAIL", null,
    `HTTP ${trader.status} | ${trader.ok ? "OK" : "Expected: trader not yet registered"}`);
}

async function testPostTxBuild(authority) {
  log("--- Phase 2: POST TX Build Tests (instruction generation only) ---");

  // Deposit
  const dep = await api("POST", "/api/tx/deposit", {
    authority, amount_usdc: DEPOSIT_USDC,
  });
  record("POST /api/tx/deposit (build)", dep.ok ? "PASS" : "FAIL", null,
    `HTTP ${dep.status} | ${dep.ok ? dep.json.instructions.length + " instructions" : dep.text.substring(0, 100)}`);

  // Market order
  const mo = await api("POST", "/api/tx/market-order", {
    authority, symbol: MARKET_SYMBOL, side: "bid", size_lots: MARKET_SIZE_LOTS,
  });
  record("POST /api/tx/market-order (build)", mo.ok ? "PASS" : "FAIL", null,
    `HTTP ${mo.status} | ${mo.ok ? mo.json.instructions.length + " instructions" : mo.text.substring(0, 100)}`);

  // Limit order
  const lo = await api("POST", "/api/tx/limit-order", {
    authority, symbol: MARKET_SYMBOL, side: "bid", price: LIMIT_PRICE, size_lots: LIMIT_SIZE_LOTS,
  });
  record("POST /api/tx/limit-order (build)", lo.ok ? "PASS" : "FAIL", null,
    `HTTP ${lo.status} | ${lo.ok ? lo.json.instructions.length + " instructions" : lo.text.substring(0, 100)}`);

  // Cancel (with dummy order IDs — tests instruction build only)
  const co = await api("POST", "/api/tx/cancel-orders", {
    authority, symbol: MARKET_SYMBOL, order_ids: [{ price: 50.0, order_sequence_number: 1 }],
  });
  record("POST /api/tx/cancel-orders (build)", co.ok ? "PASS" : "FAIL", null,
    `HTTP ${co.status} | ${co.ok ? co.json.instructions.length + " instructions" : co.text.substring(0, 100)}`);

  // Withdraw
  const wd = await api("POST", "/api/tx/withdraw", {
    authority, amount_usdc: WITHDRAW_USDC,
  });
  record("POST /api/tx/withdraw (build)", wd.ok ? "PASS" : "FAIL", null,
    `HTTP ${wd.status} | ${wd.ok ? wd.json.instructions.length + " instructions" : wd.text.substring(0, 100)}`);
}

async function testErrorHandling(authority) {
  log("--- Phase 3: Error Handling Tests ---");

  // Invalid pubkey
  const e1 = await api("POST", "/api/tx/market-order", {
    authority: "INVALID", symbol: MARKET_SYMBOL, side: "bid", size_lots: 1,
  });
  record("Error: invalid pubkey → 400", e1.status === 400 ? "PASS" : "FAIL", null,
    `HTTP ${e1.status} | ${e1.text.substring(0, 100)}`);

  // Invalid side
  const e2 = await api("POST", "/api/tx/market-order", {
    authority, symbol: MARKET_SYMBOL, side: "invalid", size_lots: 1,
  });
  record("Error: invalid side → 400", e2.status === 400 ? "PASS" : "FAIL", null,
    `HTTP ${e2.status} | ${e2.text.substring(0, 100)}`);

  // Zero size
  const e3 = await api("POST", "/api/tx/market-order", {
    authority, symbol: MARKET_SYMBOL, side: "bid", size_lots: 0,
  });
  record("Error: zero size → 400", e3.status === 400 ? "PASS" : "FAIL", null,
    `HTTP ${e3.status} | ${e3.text.substring(0, 100)}`);

  // Invalid market
  const e4 = await api("GET", "/api/orderbook/INVALID");
  record("Error: invalid market → 404", e4.status === 404 ? "PASS" : "FAIL", null,
    `HTTP ${e4.status}`);

  // Negative price
  const e5 = await api("POST", "/api/tx/limit-order", {
    authority, symbol: MARKET_SYMBOL, side: "bid", price: -1, size_lots: 1,
  });
  record("Error: negative price → 400", e5.status === 400 ? "PASS" : "FAIL", null,
    `HTTP ${e5.status} | ${e5.text.substring(0, 100)}`);
}

async function testWebSocket() {
  log("--- Phase 4: WebSocket Test ---");

  return new Promise((resolve) => {
    let gotMessage = false;
    const timeout = setTimeout(() => {
      if (!gotMessage) {
        record("WS orderbook subscription", "FAIL", null, "Timed out after 15s — no message received");
      }
      try { ws.close(); } catch {}
      resolve();
    }, 15000);

    let ws;
    try {
      // Dynamic import for ws (may or may not be installed)
      import("ws").then(({ default: WebSocket }) => {
        ws = new WebSocket(WS_URL);

        ws.on("open", () => {
          log("WS connected, subscribing to orderbook:SOL...");
          ws.send(JSON.stringify({
            type: "subscribe",
            channel: "orderbook",
            symbol: "SOL",
          }));
        });

        ws.on("message", (data) => {
          if (!gotMessage) {
            gotMessage = true;
            const msg = data.toString().substring(0, 200);
            record("WS orderbook subscription", "PASS", null, `First message: ${msg}...`);
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });

        ws.on("error", (err) => {
          record("WS orderbook subscription", "FAIL", null, `Error: ${err.message}`);
          clearTimeout(timeout);
          resolve();
        });
      }).catch((err) => {
        record("WS orderbook subscription", "SKIP", null, "ws module not installed — run: npm install ws");
        clearTimeout(timeout);
        resolve();
      });
    } catch (err) {
      record("WS orderbook subscription", "SKIP", null, "ws module not available");
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function testFullTxFlow(connection, kp, authority) {
  log("--- Phase 5: Full TX Flow (on-chain) ---");

  // Check SOL balance first
  const balance = await connection.getBalance(kp.publicKey);
  log(`Wallet SOL balance: ${balance / 1e9} SOL`);
  if (balance < 10_000_000) {
    record("Balance check", "FAIL", null, `Only ${balance / 1e9} SOL — need at least 0.01 SOL for fees`);
    return;
  }

  // Step 0: Register cross-margin trader account (required before first deposit)
  log("Step 0: Register cross-margin trader account...");
  const traderCheck = await api("GET", `/api/trader/${authority}`);
  if (traderCheck.ok) {
    record("TX: Register trader", "PASS", null, "Already registered (skipped)");
  } else {
    try {
      const reg = await api("POST", "/api/tx/register-subaccount", {
        authority, subaccount_index: 0,
      });
      if (!reg.ok) throw new Error(`Backend returned ${reg.status}: ${reg.text}`);
      const ixs = deserializeInstructions(reg.json.instructions);
      const sig = await buildSignSubmit(connection, kp, ixs);
      record("TX: Register trader", "PASS", sig, "Cross-margin account created");
    } catch (err) {
      // If already registered, simulation may fail — that's OK, continue
      if (err.message.includes("already in use") || err.message.includes("InvalidAccountData")) {
        record("TX: Register trader", "PASS", null, "Already registered (skipped)");
      } else {
        record("TX: Register trader", "FAIL", null, err.message.substring(0, 200));
        log("Registration failed — skipping remaining TX steps");
        return;
      }
    }
  }

  // Step 1: Deposit USDC
  log("Step 1: Deposit USDC...");
  try {
    const dep = await api("POST", "/api/tx/deposit", {
      authority, amount_usdc: DEPOSIT_USDC,
    });
    if (!dep.ok) throw new Error(`Backend returned ${dep.status}: ${dep.text}`);
    const ixs = deserializeInstructions(dep.json.instructions);
    const sig = await buildSignSubmit(connection, kp, ixs);
    record("TX: Deposit USDC", "PASS", sig, `${DEPOSIT_USDC} USDC deposited`);
  } catch (err) {
    record("TX: Deposit USDC", "FAIL", null, err.message.substring(0, 200));
    log("Deposit failed — skipping remaining TX steps");
    return;
  }

  // Step 2: Market order (bid)
  log("Step 2: Market order bid...");
  try {
    const mo = await api("POST", "/api/tx/market-order", {
      authority, symbol: MARKET_SYMBOL, side: "bid", size_lots: MARKET_SIZE_LOTS,
    });
    if (!mo.ok) throw new Error(`Backend returned ${mo.status}: ${mo.text}`);
    const ixs = deserializeInstructions(mo.json.instructions);
    const sig = await buildSignSubmit(connection, kp, ixs);
    record("TX: Market order (bid)", "PASS", sig, `${MARKET_SIZE_LOTS} lot(s) SOL`);
  } catch (err) {
    record("TX: Market order (bid)", "FAIL", null, err.message.substring(0, 200));
    // Try to continue — may still have position from partial fill
  }

  // Step 3: Close position (market ask)
  log("Step 3: Close position (market ask)...");
  try {
    const cl = await api("POST", "/api/tx/market-order", {
      authority, symbol: MARKET_SYMBOL, side: "ask", size_lots: MARKET_SIZE_LOTS,
    });
    if (!cl.ok) throw new Error(`Backend returned ${cl.status}: ${cl.text}`);
    const ixs = deserializeInstructions(cl.json.instructions);
    const sig = await buildSignSubmit(connection, kp, ixs);
    record("TX: Close position (ask)", "PASS", sig, `${MARKET_SIZE_LOTS} lot(s) SOL`);
  } catch (err) {
    record("TX: Close position (ask)", "FAIL", null, err.message.substring(0, 200));
  }

  // Step 4: Limit order (bid at far-below-market price)
  log("Step 4: Limit order...");
  let limitOrderPlaced = false;
  try {
    const lo = await api("POST", "/api/tx/limit-order", {
      authority, symbol: MARKET_SYMBOL, side: "bid", price: LIMIT_PRICE, size_lots: LIMIT_SIZE_LOTS,
    });
    if (!lo.ok) throw new Error(`Backend returned ${lo.status}: ${lo.text}`);
    const ixs = deserializeInstructions(lo.json.instructions);
    const sig = await buildSignSubmit(connection, kp, ixs);
    record("TX: Limit order (bid)", "PASS", sig, `${LIMIT_SIZE_LOTS} lot(s) SOL @ $${LIMIT_PRICE}`);
    limitOrderPlaced = true;
  } catch (err) {
    record("TX: Limit order (bid)", "FAIL", null, err.message.substring(0, 200));
  }

  // Step 5: Cancel limit order
  // We need to find the order ID. Try fetching from trader endpoint.
  if (limitOrderPlaced) {
    log("Step 5: Cancel limit order...");
    try {
      // Fetch trader state to get limit order details
      const traderState = await api("GET", `/api/trader/${authority}`);
      const limitOrders = traderState.json?.accounts?.[0]?.limitOrders?.[MARKET_SYMBOL];
      if (traderState.ok && limitOrders?.length > 0) {
        const order = limitOrders[0];
        // Extract USD price and order sequence number
        const usdPrice = parseFloat(order.price?.ui ?? LIMIT_PRICE);
        const osn = order.orderSequenceNumber ?? order.order_sequence_number ?? "1";
        const cancelReq = {
          authority,
          symbol: MARKET_SYMBOL,
          order_ids: [{
            price: usdPrice,
            order_sequence_number: String(osn),
          }],
        };
        log(`Cancel request: price=${usdPrice}, osn=${osn}`);
        const co = await api("POST", "/api/tx/cancel-orders", cancelReq);
        if (!co.ok) throw new Error(`Backend returned ${co.status}: ${co.text}`);
        const ixs = deserializeInstructions(co.json.instructions);
        const sig = await buildSignSubmit(connection, kp, ixs);
        record("TX: Cancel limit order", "PASS", sig, "Order cancelled");
      } else {
        record("TX: Cancel limit order", "SKIP", null,
          `No limit orders found in trader state for ${MARKET_SYMBOL}`);
      }
    } catch (err) {
      record("TX: Cancel limit order", "FAIL", null, err.message.substring(0, 200));
    }
  } else {
    record("TX: Cancel limit order", "SKIP", null, "Limit order was not placed");
  }

  // Step 6: Withdraw USDC
  log("Step 6: Withdraw USDC...");
  try {
    const wd = await api("POST", "/api/tx/withdraw", {
      authority, amount_usdc: WITHDRAW_USDC,
    });
    if (!wd.ok) throw new Error(`Backend returned ${wd.status}: ${wd.text}`);
    const ixs = deserializeInstructions(wd.json.instructions);
    const sig = await buildSignSubmit(connection, kp, ixs);
    record("TX: Withdraw USDC", "PASS", sig, `${WITHDRAW_USDC} USDC withdrawn`);
  } catch (err) {
    record("TX: Withdraw USDC", "FAIL", null, err.message.substring(0, 200));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let keypair;

async function main() {
  log("=== Ember Terminal E2E Live Test ===");
  log(`Backend: ${BACKEND}`);
  log(`RPC: ${RPC_URL}`);
  log("");

  // Load keypair
  const keypairData = JSON.parse(readFileSync(KEYPAIR_PATH, "utf-8"));
  keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const authority = keypair.publicKey.toBase58();
  log(`Wallet: ${authority}`);

  const connection = new Connection(RPC_URL, "confirmed");

  // Run all test phases
  await testGetEndpoints();
  log("");
  await testPostTxBuild(authority);
  log("");
  await testErrorHandling(authority);
  log("");
  await testWebSocket();
  log("");
  await testFullTxFlow(connection, keypair, authority);

  // Final report
  log("");
  log("=== FINAL REPORT ===");
  log("─".repeat(100));
  log(
    "Step".padEnd(40) +
    "Status".padEnd(8) +
    "TX Signature".padEnd(50) +
    "Detail"
  );
  log("─".repeat(100));

  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    log(
      r.step.padEnd(40) +
      r.status.padEnd(8) +
      (r.txSig === "—" ? "—".padEnd(50) : r.txSig.padEnd(50)) +
      r.detail
    );
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else skip++;
  }

  log("─".repeat(100));
  log(`TOTAL: ${pass} PASS | ${fail} FAIL | ${skip} SKIP | ${results.length} tests`);
  log("");

  if (fail > 0) {
    log("❌ E2E TEST SUITE: FAIL");
    process.exit(1);
  } else {
    log("✅ E2E TEST SUITE: PASS");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[E2E] Fatal error:", err);
  process.exit(1);
});
