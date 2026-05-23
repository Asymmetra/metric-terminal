#!/usr/bin/env node
/**
 * Live (real-network, real-money) Imperial test suite runner.
 *
 * Supersedes the single-file tests/imperial-live.mjs with a modular suite: each
 * scenario lives in tests/live/scenarios/ and is selectable by id. Scenarios are
 * repeatable (funds return to the wallet) and easy to add — drop a new file in
 * scenarios/ and register it in SCENARIOS below.
 *
 * Wallet: .keys/test-wallet.json (real mainnet funds).
 *
 * Usage (from repo root):
 *   node tests/live/run.mjs --list                     # show all scenarios
 *   node tests/live/run.mjs                             # safe only (reads, no money)
 *   node tests/live/run.mjs --orderbot                  # safe + order-bot (no wallet sig)
 *   node tests/live/run.mjs --all SOLANA_RPC=…          # everything (spends fees)
 *   node tests/live/run.mjs roundtrip-market            # one scenario by id
 *
 * Env:
 *   SOLANA_RPC   required for `onchain` scenarios (wallet-signed txs)
 *   PROFILE      sub-account index 0..5 (default 0)
 *   AMOUNT_USD / BUFFER_USD  per-scenario tunables
 */

import { makeReporter, makeCtx, ensureJwt, getRpc, walletSol, walletUsdc, WALLET, API } from "./harness.mjs";
import * as authReads from "./scenarios/auth-reads.mjs";
import * as limitCancel from "./scenarios/limit-cancel.mjs";
import * as limitUpdateCancel from "./scenarios/limit-update-cancel.mjs";
import * as accountBootstrap from "./scenarios/account-bootstrap.mjs";
import * as depositWithdraw from "./scenarios/deposit-withdraw.mjs";
import * as roundtripMarket from "./scenarios/roundtrip-market.mjs";
import * as roundtripAuto from "./scenarios/roundtrip-auto.mjs";
import * as phoenixMarket from "./scenarios/phoenix-market.mjs";
import * as partialClose from "./scenarios/partial-close.mjs";
import * as collateralAdjust from "./scenarios/collateral-adjust.mjs";

// Registry — order matters (safe → order-bot → on-chain). Add new files here.
const SCENARIOS = [
  authReads,
  limitCancel,
  limitUpdateCancel,
  accountBootstrap,
  depositWithdraw,
  roundtripAuto,
  phoenixMarket,
  roundtripMarket,
  partialClose,
  collateralAdjust,
].map((m) => ({ ...m.meta, run: m.default }));

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function printList() {
  process.stdout.write(`${BOLD}Live Imperial scenarios${RESET}\n`);
  for (const s of SCENARIOS) {
    process.stdout.write(`  ${s.id.padEnd(22)} ${DIM}[${s.kind}]${RESET}  ${s.summary}\n${DIM}${" ".repeat(26)}cost: ${s.cost}${RESET}\n`);
  }
}

function select(args) {
  const ids = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  if (ids.length) {
    const chosen = ids.map((id) => SCENARIOS.find((s) => s.id === id));
    const missing = ids.filter((id, i) => !chosen[i]);
    if (missing.length) throw new Error(`unknown scenario(s): ${missing.join(", ")}`);
    return chosen;
  }
  if (flags.has("--all")) return SCENARIOS;
  if (flags.has("--orderbot")) return SCENARIOS.filter((s) => s.kind === "safe" || s.kind === "orderbot");
  return SCENARIOS.filter((s) => s.kind === "safe");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    printList();
    return 0;
  }

  let chosen;
  try {
    chosen = select(args);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  const r = makeReporter();
  const ctx = makeCtx(r);
  const needsRpc = chosen.some((s) => s.kind === "onchain");

  process.stdout.write(`${BOLD}Imperial live suite${RESET}  ${DIM}wallet=${WALLET}  api=${API}${RESET}\n`);
  process.stdout.write(`${DIM}running: ${chosen.map((s) => s.id).join(", ")}${RESET}\n`);

  if (needsRpc) {
    if (!process.env.SOLANA_RPC) {
      process.stderr.write(`\nThese scenarios need on-chain signing — set SOLANA_RPC=https://… and re-run.\n`);
      return 2;
    }
    try {
      const rpc = getRpc();
      const sol = await walletSol(rpc);
      const usdc = await walletUsdc(rpc);
      process.stdout.write(`${DIM}wallet on-chain: ${sol.toFixed(4)} SOL · $${usdc.toFixed(4)} USDC${RESET}\n`);
    } catch (e) {
      process.stderr.write(`RPC check failed: ${e.message}\n`);
      return 2;
    }
  }

  // One JWT handshake for the whole run.
  try {
    await ensureJwt();
  } catch (e) {
    r.bad("auth handshake", e);
    r.summary();
    return 1;
  }

  for (const s of chosen) {
    r.section(`${s.id}  ${DIM}— ${s.summary}${RESET}`);
    try {
      await s.run(ctx);
    } catch (e) {
      r.bad(s.id, e);
    }
  }

  const { fail } = r.summary();
  return fail === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
