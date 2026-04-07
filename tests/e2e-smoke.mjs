#!/usr/bin/env node
/**
 * E2E Smoke Test - Ember Terminal
 * Quick health check (~3-5 minutes)
 *
 * Usage: node e2e-smoke.mjs [--verbose]
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const BACKEND_URL = process.env.BACKEND_URL || 'https://ember-backend-q4nf.onrender.com';
const RPC_URL = process.env.RPC_URL;
const TEST_WALLET_PUBKEY = 'HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x';

const VERBOSE = process.argv.includes('--verbose');

// Test results
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

// Utilities
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const verbose = (msg) => VERBOSE && log(`[VERBOSE] ${msg}`);

async function apiCall(endpoint, options = {}) {
  const url = `${BACKEND_URL}${endpoint}`;
  verbose(`Calling: ${options.method || 'GET'} ${url}`);

  const fetchOpts = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  };

  let response = await fetch(url, fetchOpts);

  // Retry up to 3 times on 502 (cold Render instance)
  for (let retry = 1; retry <= 3 && response.status === 502; retry++) {
    const delay = retry * 3000; // 3s, 6s, 9s
    verbose(`Got 502, retry ${retry}/3 after ${delay / 1000}s...`);
    await new Promise(r => setTimeout(r, delay));
    response = await fetch(url, fetchOpts);
  }

  const data = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, data };
}

async function testCase(name, fn) {
  log(`Running: ${name}`);
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.passed++;
    results.tests.push({ name, status: 'PASS', duration });
    log(`✅ PASS: ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    results.failed++;
    results.tests.push({ name, status: 'FAIL', duration, error: error.message });
    log(`❌ FAIL: ${name} - ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Tests
async function runTests() {
  log('=================================');
  log('Ember Terminal E2E Smoke Test');
  log(`Backend: ${BACKEND_URL}`);
  log(`Test Wallet: ${TEST_WALLET_PUBKEY}`);
  log('=================================\n');

  // Warmup: wake Render instance (may be cold-sleeping)
  log('Warming up backend...');
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/markets`);
      if (res.ok) { log(`Warmup OK (attempt ${attempt})`); break; }
      log(`Warmup attempt ${attempt}: HTTP ${res.status}`);
    } catch (e) {
      log(`Warmup attempt ${attempt}: ${e.message}`);
    }
    if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
  }
  log('');

  // Test 1: Health check - Markets endpoint
  await testCase('Health Check - Markets', async () => {
    const { ok, data, status } = await apiCall('/api/markets');
    verbose(`Response status: ${status}`);
    verbose(`Markets: ${JSON.stringify(data?.slice(0, 2), null, 2)}...`);
    assert(ok, `Markets endpoint failed with status ${status}`);
    assert(Array.isArray(data) && data.length > 0, 'Markets should be non-empty array');
  });

  // Test 2: Trader data
  await testCase('Trader Data Fetch', async () => {
    const { ok, data, status } = await apiCall(`/api/trader/${TEST_WALLET_PUBKEY}`);
    verbose(`Response status: ${status}`);
    verbose(`Trader data: ${JSON.stringify(data, null, 2)}`);
    assert(ok || status === 404, `Trader endpoint failed with status ${status}`);
    // 404 is OK for new wallets
    if (ok) {
      assert(data && typeof data === 'object', 'Trader data should be an object');
    }
  });

  // Test 3: Orderbook data
  await testCase('Orderbook Data - SOL', async () => {
    const { ok, data, status } = await apiCall('/api/orderbook/SOL');
    verbose(`Response status: ${status}`);
    verbose(`Orderbook bids: ${data?.bids?.length || 0}, asks: ${data?.asks?.length || 0}`);
    assert(ok || status === 404, `Orderbook endpoint failed with status ${status}`);
    // 404 is OK when market relay isn't running (empty cache)
    if (ok) {
      assert(data && typeof data === 'object', 'Orderbook should be an object');
      assert(Array.isArray(data.bids), 'Orderbook should have bids array');
      assert(Array.isArray(data.asks), 'Orderbook should have asks array');
    }
  });

  // Test 4: Register subaccount (index=0 - cross-margin)
  await testCase('Build Register Subaccount (index=0)', async () => {
    const { ok, data, status } = await apiCall('/api/tx/register-subaccount', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        subaccount_index: 0
      })
    });
    verbose(`Response status: ${status}`);
    verbose(`Instructions count: ${data?.instructions?.length || 0}`);

    // Should succeed or return 400 if already registered
    assert(ok || status === 400, `Register subaccount failed with status ${status}`);

    if (ok) {
      assert(Array.isArray(data.instructions), 'Should return instructions array');
      assert(data.instructions.length > 0, 'Should have at least one instruction');
    }
  });

  // Test 5: Build deposit transaction
  await testCase('Build Deposit Transaction', async () => {
    const { ok, data, status } = await apiCall('/api/tx/deposit', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        amount_usdc: 10.0 // 10 USDC
      })
    });
    verbose(`Response status: ${status}`);
    verbose(`Instructions count: ${data?.instructions?.length || 0}`);

    assert(ok, `Deposit endpoint failed with status ${status}`);
    assert(Array.isArray(data.instructions), 'Should return instructions array');
    assert(data.instructions.length > 0, 'Should have at least one instruction');
  });

  // Test 6: Build market order transaction
  await testCase('Build Market Order Transaction', async () => {
    const { ok, data, status } = await apiCall('/api/tx/market-order', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        side: 'buy',
        size_lots: 100000000
      })
    });
    verbose(`Response status: ${status}`);
    verbose(`Instructions count: ${data?.instructions?.length || 0}`);

    assert(ok, `Market order endpoint failed with status ${status}`);
    assert(Array.isArray(data.instructions), 'Should return instructions array');
  });

  // Test 7: Build limit order transaction
  await testCase('Build Limit Order Transaction', async () => {
    const { ok, data, status } = await apiCall('/api/tx/limit-order', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        side: 'buy',
        price: 100.00,
        size_lots: 100000000
      })
    });
    verbose(`Response status: ${status}`);
    verbose(`Instructions count: ${data?.instructions?.length || 0}`);

    assert(ok, `Limit order endpoint failed with status ${status}`);
    assert(Array.isArray(data.instructions), 'Should return instructions array');
  });

  // Test 8: Candles data
  await testCase('Candles Data - SOL', async () => {
    const { ok, data, status } = await apiCall('/api/candles/SOL?timeframe=1m');
    verbose(`Response status: ${status}`);
    verbose(`Candles count: ${data?.length || 0}`);
    assert(ok || status === 404, `Candles endpoint failed with status ${status}`);
    // 404 is OK if no candle data yet
    if (ok) {
      assert(Array.isArray(data), 'Candles should be an array');
    }
  });

  // Print summary
  log('\n=================================');
  log('Smoke Test Summary');
  log('=================================');
  log(`Total: ${results.passed + results.failed}`);
  log(`Passed: ${results.passed} ✅`);
  log(`Failed: ${results.failed} ❌`);
  log('=================================');

  // Exit code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
