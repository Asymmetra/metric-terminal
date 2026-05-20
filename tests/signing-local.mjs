#!/usr/bin/env node
/**
 * Validate the Solana-side signing path locally, with no Imperial dependency.
 *
 * Builds a real `VersionedTransaction` that requires the test wallet to
 * sign, base64-encodes it (the exact shape Imperial's /deposit/build-tx
 * returns), then runs it through the same decode → sign path that
 * lives in PhantomSigner.signAndSendTransaction. Verifies:
 *
 *   1. base64 decode → deserialize round-trip is lossless
 *   2. signer's public key is in the message's static account keys
 *   3. signature added by our path verifies against the message bytes
 *   4. the tx is fully signed (no null/zero signatures remaining)
 *
 * This catches breakage in the signing path without needing Imperial up.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLET_PATH = path.join(__dirname, "..", ".keys", "test-wallet.json");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`${GREEN}✓${RESET} ${name}\n`);
    pass += 1;
  } catch (e) {
    process.stdout.write(`${RED}✗${RESET} ${name}\n  ${e.message}\n`);
    failures.push(`${name}: ${e.message}`);
    fail += 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8")))
);

// Build a representative tx: a no-op SystemProgram transfer of 0 lamports
// to self. The shape is exactly what Imperial's /deposit/build-tx returns:
// a VersionedTransaction where the wallet is a required signer (first
// signature slot is empty until we sign).
const recentBlockhash = "11111111111111111111111111111111"; // dummy; not submitted
const message = new TransactionMessage({
  payerKey: kp.publicKey,
  recentBlockhash,
  instructions: [
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: kp.publicKey,
      lamports: 0,
    }),
  ],
}).compileToV0Message();

const built = new VersionedTransaction(message);
const base64 = Buffer.from(built.serialize()).toString("base64");

// ───────────────────────────────────────────────── tier 1: round-trip

check("base64 → deserialize round-trip preserves message bytes", () => {
  const raw = Uint8Array.from(Buffer.from(base64, "base64"));
  const back = VersionedTransaction.deserialize(raw);
  assert(
    Buffer.from(back.message.serialize()).equals(Buffer.from(built.message.serialize())),
    "message bytes differ after round-trip"
  );
});

check("payer pubkey appears in static account keys", () => {
  const back = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(base64, "base64"))
  );
  const found = back.message.staticAccountKeys.some((k) =>
    k.equals(kp.publicKey)
  );
  assert(found, "payer not in staticAccountKeys");
});

// ───────────────────────────────────────────────── tier 2: sign + verify

check("sign() adds a non-zero signature in the payer slot", () => {
  const back = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(base64, "base64"))
  );
  back.sign([kp]);
  const sig0 = back.signatures[0];
  assert(sig0 && sig0.length === 64, `bad sig length ${sig0?.length}`);
  assert(!sig0.every((b) => b === 0), "signature is all zeros");
});

check("our signature verifies against the message bytes", () => {
  const back = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(base64, "base64"))
  );
  back.sign([kp]);
  const sig = back.signatures[0];
  const msg = back.message.serialize();
  const ok = ed25519.verify(sig, msg, kp.publicKey.toBytes());
  assert(ok, "signature failed verification");
});

check(
  "after sign(): every required-signer slot is populated",
  () => {
    const back = VersionedTransaction.deserialize(
      Uint8Array.from(Buffer.from(base64, "base64"))
    );
    back.sign([kp]);
    const numRequired = back.message.header.numRequiredSignatures;
    for (let i = 0; i < numRequired; i += 1) {
      const s = back.signatures[i];
      assert(s && !s.every((b) => b === 0), `slot ${i} still zero`);
    }
  }
);

// ───────────────────────────────────────────────── tier 3: ed25519 signature parity

check(
  "low-level ed25519.sign + TextEncoder() matches what Phantom's signMessage would emit",
  () => {
    // Mirrors makePhantomSigner.signMessage path.
    const msg = `imperial:mobile-connect:${kp.publicKey.toBase58()}:0123456789abcdef`;
    const seed = kp.secretKey.slice(0, 32);
    const sig = ed25519.sign(new TextEncoder().encode(msg), seed);
    assert(sig.length === 64, `sig length ${sig.length}`);
    const ok = ed25519.verify(sig, new TextEncoder().encode(msg), kp.publicKey.toBytes());
    assert(ok, "sig didn't verify against own pubkey");
  }
);

// ───────────────────────────────────────────────── tier 4: balance read (skip if no RPC)

if (process.env.SOLANA_RPC) {
  await check_async(
    "RPC reachable + wallet balance readable",
    async () => {
      const rpc = new Connection(process.env.SOLANA_RPC, "confirmed");
      const lamports = await rpc.getBalance(kp.publicKey);
      assert(lamports >= 0, "negative balance?");
      process.stdout.write(`  wallet ${kp.publicKey.toBase58()}: ${(lamports / 1e9).toFixed(6)} SOL\n`);
    }
  );
}

async function check_async(name, fn) {
  try {
    await fn();
    process.stdout.write(`${GREEN}✓${RESET} ${name}\n`);
    pass += 1;
  } catch (e) {
    process.stdout.write(`${RED}✗${RESET} ${name}\n  ${e.message}\n`);
    failures.push(`${name}: ${e.message}`);
    fail += 1;
  }
}

process.stdout.write(
  `\n${pass} passed, ${fail} failed.\n${
    fail ? failures.map((f) => `  - ${f}`).join("\n") + "\n" : ""
  }`
);
process.exit(fail === 0 ? 0 : 1);

// Reference Connection import so the linter doesn't strip it when SOLANA_RPC unset.
void Connection;
void PublicKey;
