#!/usr/bin/env node
/**
 * Real-network integration suite for the metric-terminal ↔ Imperial stack.
 *
 * Uses the test wallet at .keys/test-wallet.json. Runs three escalating
 * tiers; each tier is opt-in via an env flag so you can run the safe
 * tier alone without on-chain side effects.
 *
 *   T1  (always)              Imperial auth handshake + read endpoints
 *                             (no chain writes, no money required)
 *   T2  (DEPOSIT=1)           /deposit/build-tx → sign → submit → confirm
 *                             on-chain → re-fetch balances
 *   T3  (ORDER=1)             POST /mobile/orders (limit, well off-market)
 *                             → /mobile/orders/cancel
 *
 * Env:
 *   SOLANA_RPC   Required for T2 + T3. Use a Helius/QuickNode endpoint;
 *                public mainnet-beta will rate-limit aggressively.
 *   DEPOSIT_USDC Default 1. Amount in dollars to deposit when T2 is on.
 *   PROFILE      Default 0. Sub-account index 0..5.
 *
 * Run from repo root:
 *   node tests/imperial-live.mjs           # T1 only
 *   DEPOSIT=1 SOLANA_RPC=... node ...      # T1 + T2
 *   ORDER=1 SOLANA_RPC=... node ...        # T1 + T3
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";

// ─────────────────────────────────────────────────────────── setup

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WALLET_PATH = path.join(REPO_ROOT, ".keys/test-wallet.json");
const API = process.env.IMPERIAL_API_URL ?? "https://api.imperial.space";
const PROFILE = Number(process.env.PROFILE ?? "0");
const DEPOSIT_USDC = Number(process.env.DEPOSIT_USDC ?? "1");

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

let pass = 0;
let fail = 0;
const failures = [];

function tier(name) {
  process.stdout.write(`\n${CYAN}== ${name} ==${RESET}\n`);
}
function ok(name, detail) {
  pass += 1;
  process.stdout.write(`${GREEN}✓${RESET} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ""}\n`);
}
function bad(name, e) {
  fail += 1;
  const msg = e instanceof Error ? e.message : String(e);
  failures.push(`${name}: ${msg}`);
  process.stdout.write(`${RED}✗${RESET} ${name}\n  ${YELLOW}${msg}${RESET}\n`);
}
function info(line) {
  process.stdout.write(`${DIM}  ${line}${RESET}\n`);
}

// ─────────────────────────────────────────────────────────── helpers

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8")))
);
const WALLET = kp.publicKey.toBase58();

const RETRY_TLS_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
]);

async function http(method, path, { body, jwt, retries = 4 } = {}) {
  const headers = { "content-type": "application/json" };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetch(`${API}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const code = e?.cause?.code ?? e?.code;
      lastErr = new Error(`${method} ${path}: ${e.message} (${code ?? "?"})`);
      if (attempt < retries && (RETRY_TLS_CODES.has(code) || !code)) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
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
    // Retry transient 5xx (upstream Redis blips etc.).
    if (res.status >= 500 && res.status <= 599 && attempt < retries) {
      lastErr = new Error(`${method} ${path}: ${res.status} ${JSON.stringify(parsed)}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    return { status: res.status, body: parsed };
  }
  throw lastErr;
}

function signConnectMessage(message) {
  // Imperial expects a base58-encoded ed25519 signature over the UTF-8
  // bytes of the message. Solana Keypair holds a 64-byte secret where
  // the first 32 bytes are the ed25519 seed; ed25519.sign takes that
  // seed and signs in one shot.
  const seed = kp.secretKey.slice(0, 32);
  const sig = ed25519.sign(new TextEncoder().encode(message), seed);
  return bs58.encode(sig);
}

function makeNonce() {
  // Imperial's order bot requires the nonce to parse as u64 and be within
  // ±5 minutes of now (accepts seconds or ms). Hex/UUID nonces produce
  // a 400 "Invalid nonce format" inside the bot, which the API surfaces
  // as a generic 401 "Failed to generate mobile session".
  return Date.now().toString();
}

// ─────────────────────────────────────────────────────────── T1: auth + reads

let JWT = null;

tier(`T1 · auth + reads  (wallet=${WALLET})`);

try {
  // 1. /mobile/connect with a real signature.
  const nonce = makeNonce();
  const message = `imperial:mobile-connect:${WALLET}:${nonce}`;
  const signature = signConnectMessage(message);
  const connect = await http("POST", "/mobile/connect", {
    body: { wallet: WALLET, message, signature },
  });
  if (connect.status !== 200 || !connect.body?.code) {
    throw new Error(`status ${connect.status}: ${JSON.stringify(connect.body)}`);
  }
  ok("POST /mobile/connect", `code=${connect.body.code.slice(0, 12)}…`);

  // 2. /mobile/exchange for a JWT.
  const exchange = await http("POST", "/mobile/exchange", {
    body: { code: connect.body.code },
  });
  if (exchange.status !== 200 || !exchange.body?.jwt) {
    throw new Error(`status ${exchange.status}: ${JSON.stringify(exchange.body)}`);
  }
  JWT = exchange.body.jwt;
  const ttlMin = Math.round((exchange.body.expiresAt - Date.now() / 1000) / 60);
  ok("POST /mobile/exchange", `jwt(${JWT.length} chars) ttl≈${ttlMin}m`);
} catch (e) {
  bad("auth handshake", e);
}

if (JWT) {
  // 3. /mobile/balances
  try {
    const r = await http("GET", "/mobile/balances", { jwt: JWT });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    const profiles = r.body.profiles ?? [];
    if (!Array.isArray(profiles) || profiles.length !== 6) {
      throw new Error(`expected 6 profiles, got ${profiles.length}`);
    }
    const profile0 = profiles[0];
    ok(
      "GET /mobile/balances",
      `profile0 USDC: ${(profile0.usdc / 1e6).toFixed(2)}  pda: ${profile0.profilePda.slice(0, 10)}…`
    );
    for (const p of profiles) {
      info(`profile ${p.profileIndex}: usdc=${(p.usdc / 1e6).toFixed(6)}  pda=${p.profilePda.slice(0, 10)}…`);
    }
  } catch (e) {
    bad("GET /mobile/balances", e);
  }
}

// 4. /positions (no auth)
try {
  const r = await http("GET", `/positions?walletAddress=${WALLET}`);
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  ok("GET /positions", `open=${r.body.count}  lifetimePnl=$${r.body.lifetimePnlUsd}`);
} catch (e) {
  bad("GET /positions", e);
}

// 5. /trades (no auth)
try {
  const r = await http("GET", `/trades?walletAddress=${WALLET}&limit=5`);
  if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
  ok("GET /trades?limit=5", `total=${r.body.totalCount}`);
} catch (e) {
  bad("GET /trades", e);
}

// 6. /mark-prices spot-check
try {
  const r = await http("GET", "/mark-prices");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const sol = r.body.rows.find((row) => row.symbol === "SOL");
  const px = sol?.phoenix?.price ?? sol?.flash?.price ?? sol?.gmtrade?.price;
  ok("GET /mark-prices", `SOL=${px ?? "?"}  rows=${r.body.rows.length}`);
} catch (e) {
  bad("GET /mark-prices", e);
}

// ─────────────────────────────────────────────────────────── T2: deposit

if (process.env.DEPOSIT === "1") {
  tier("T2 · deposit flow");
  if (!process.env.SOLANA_RPC) {
    bad("deposit", new Error("set SOLANA_RPC=https://… to submit on-chain"));
  } else {
    try {
      const rpc = new Connection(process.env.SOLANA_RPC, "confirmed");
      const lamports = await rpc.getBalance(kp.publicKey);
      info(`SOL gas balance: ${(lamports / 1e9).toFixed(6)} SOL`);
      if (lamports < 0.01 * 1e9) {
        throw new Error(
          `wallet needs SOL for gas (have ${(lamports / 1e9).toFixed(6)}, need ≥0.01)`
        );
      }

      const before = JWT
        ? (await http("GET", "/mobile/balances", { jwt: JWT })).body.profiles[PROFILE]
            .usdc / 1e6
        : null;

      const build = await http("POST", "/deposit/build-tx", {
        body: {
          wallet: WALLET,
          profileIndex: PROFILE,
          amount: Math.round(DEPOSIT_USDC * 1e6),
          mode: "deposit",
        },
      });
      if (build.status !== 200 || !build.body?.transaction) {
        throw new Error(`build-tx status ${build.status}: ${JSON.stringify(build.body)}`);
      }
      ok(
        "POST /deposit/build-tx",
        `tx_bytes=${build.body.transaction.length}  amount=$${DEPOSIT_USDC}`
      );

      const raw = Buffer.from(build.body.transaction, "base64");
      const vtx = VersionedTransaction.deserialize(raw);
      vtx.sign([kp]);
      const sig = await rpc.sendTransaction(vtx, { skipPreflight: false });
      info(`submitted: ${sig}`);
      info(`explorer: https://solscan.io/tx/${sig}`);
      const conf = await rpc.confirmTransaction(sig, "confirmed");
      if (conf.value.err) {
        throw new Error(`on-chain err: ${JSON.stringify(conf.value.err)}`);
      }
      ok("deposit confirmed on-chain", sig);

      // Re-fetch balance.
      if (JWT) {
        const after =
          (await http("GET", "/mobile/balances", { jwt: JWT })).body.profiles[PROFILE]
            .usdc / 1e6;
        ok(
          "balance increased",
          `profile${PROFILE}: $${before?.toFixed(2)} → $${after.toFixed(2)}`
        );
      }
    } catch (e) {
      bad("deposit flow", e);
    }
  }
} else {
  process.stdout.write(`${DIM}\nT2 deposit flow skipped (set DEPOSIT=1 SOLANA_RPC=… to run).${RESET}\n`);
}

// ─────────────────────────────────────────────────────────── T3: order + cancel

if (process.env.ORDER === "1") {
  tier("T3 · order place + cancel");
  if (!JWT) {
    bad("order", new Error("no JWT — T1 must succeed first"));
  } else {
    try {
      // Fetch a fresh Phoenix SOL mark to ensure the limit is well off-market.
      const marks = await fetch(`${API}/api/v1/mark-prices`).then((r) => r.json());
      const solRow = marks.rows.find((r) => r.symbol === "SOL");
      const mark = solRow?.phoenix?.price ?? solRow?.flash?.price;
      if (!mark) throw new Error("no SOL mark price available");

      // Buy 50% below market — limit will rest, not fill. Imperial's
      // order bot enforces a $10 minimum collateral; sizing at 2x leverage.
      const limitPriceUsd = mark * 0.5;
      const TRIGGER_SCALE = 1e9;
      const triggerPrice = Math.round(limitPriceUsd * TRIGGER_SCALE);
      const sizeUsd = 20 * 1e6;       // $20 notional
      const collateral = 10 * 1e6;    // $10 collateral → 2x leverage

      const placeBody = {
        wallet: WALLET,
        profileIndex: PROFILE,
        underwriter: 2, // Phoenix
        side: 0, // Long
        action: 0, // Increase
        orderType: 1, // Limit
        sizeUsd,
        collateralAmount: collateral,
        slippageBps: 100,
        triggerCondition: 1, // Below
        triggerPrice,
        priority: 0,
        fundingStatus: 0,
        symbol: "SOL",
      };
      info(`placing limit: long SOL @ $${limitPriceUsd.toFixed(2)} (mark $${mark.toFixed(2)})`);
      const place = await http("POST", "/mobile/orders", { body: placeBody, jwt: JWT });
      if (place.status !== 200) throw new Error(`status ${place.status}: ${JSON.stringify(place.body)}`);
      if (!place.body.success) {
        throw new Error(`bot rejected: ${place.body.error}`);
      }
      ok(
        "POST /mobile/orders",
        `signature=${place.body.signature?.slice(0, 12)}…  orderPda=${place.body.orderPda?.slice(0, 12)}…`
      );

      const orderPda = place.body.orderPda;
      if (!orderPda) throw new Error("no orderPda returned for resting limit");

      // Cancel it.
      const cancel = await http("POST", "/mobile/orders/cancel", {
        body: { wallet: WALLET, profileIndex: PROFILE, orderPda },
        jwt: JWT,
      });
      if (cancel.status !== 200 || !cancel.body.success) {
        throw new Error(`cancel failed: ${JSON.stringify(cancel.body)}`);
      }
      ok("POST /mobile/orders/cancel", `signature=${cancel.body.signature?.slice(0, 12)}…`);
    } catch (e) {
      bad("order flow", e);
    }
  }
} else {
  process.stdout.write(`${DIM}\nT3 order flow skipped (set ORDER=1 SOLANA_RPC=… to run).${RESET}\n`);
}

// ─────────────────────────────────────────────────────────── summary

process.stdout.write(
  `\n${pass} passed, ${fail} failed.\n${
    fail ? failures.map((f) => `  - ${f}`).join("\n") + "\n" : ""
  }`
);
process.exit(fail === 0 ? 0 : 1);
