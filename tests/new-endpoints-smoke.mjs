#!/usr/bin/env node
/**
 * New Endpoints Smoke Test — multi-limit-orders + cancel-stop-loss
 * Tests endpoint validation, request/response shape, and error handling.
 * Does NOT sign or send transactions (smoke-level only).
 *
 * Usage: node new-endpoints-smoke.mjs [--verbose]
 */

const BACKEND_URL = process.env.BACKEND_URL || 'https://ember-backend-q4nf.onrender.com';
const TEST_WALLET_PUBKEY = 'HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x';
const VERBOSE = process.argv.includes('--verbose');

const results = { passed: 0, failed: 0, tests: [] };

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const verbose = (msg) => VERBOSE && log(`[VERBOSE] ${msg}`);

async function apiCall(endpoint, options = {}) {
  const url = `${BACKEND_URL}${endpoint}`;
  verbose(`Calling: ${options.method || 'GET'} ${url}`);
  let response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });

  // Retry up to 3 times on 502 (cold Render instance)
  for (let retry = 1; retry <= 3 && response.status === 502; retry++) {
    const delay = retry * 3000;
    verbose(`Got 502, retry ${retry}/3 after ${delay / 1000}s...`);
    await new Promise(r => setTimeout(r, delay));
    response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers }
    });
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

async function runTests() {
  log('=================================');
  log('New Endpoints Smoke Test');
  log(`Backend: ${BACKEND_URL}`);
  log(`Wallet:  ${TEST_WALLET_PUBKEY}`);
  log('=================================\n');

  // Warmup: wake Render instance
  log('Warming up backend...');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/markets`);
      if (res.ok) { log(`Warmup OK (attempt ${attempt})`); break; }
      log(`Warmup attempt ${attempt}: HTTP ${res.status}`);
    } catch (e) {
      log(`Warmup attempt ${attempt}: ${e.message}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  log('');

  // -----------------------------------------------------------------------
  // POST /api/tx/place-multi-limit-orders
  // -----------------------------------------------------------------------

  // 1. Valid request — bids only
  await testCase('Multi-limit: valid bids only', async () => {
    const { ok, data, status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        bids: [
          { price: 50.0, size_lots: 1 },
          { price: 49.0, size_lots: 2 }
        ],
        asks: []
      })
    });
    verbose(`Status: ${status}, Data: ${JSON.stringify(data)}`);
    assert(ok || status === 400, `Unexpected status ${status}`);
    if (ok) {
      assert(Array.isArray(data.instructions), 'Should return instructions array');
      assert(data.instructions.length > 0, 'Should have at least one instruction');
    }
  });

  // 2. Valid request — asks only
  await testCase('Multi-limit: valid asks only', async () => {
    const { ok, data, status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        bids: [],
        asks: [
          { price: 200.0, size_lots: 1 },
          { price: 201.0, size_lots: 1 }
        ]
      })
    });
    verbose(`Status: ${status}, Data: ${JSON.stringify(data)}`);
    assert(ok || status === 400, `Unexpected status ${status}`);
    if (ok) {
      assert(Array.isArray(data.instructions), 'Should return instructions array');
    }
  });

  // 3. Valid request — mixed bids and asks
  await testCase('Multi-limit: mixed bids + asks', async () => {
    const { ok, data, status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        bids: [{ price: 50.0, size_lots: 1 }],
        asks: [{ price: 200.0, size_lots: 1 }],
        slide: true
      })
    });
    verbose(`Status: ${status}, Data: ${JSON.stringify(data)}`);
    assert(ok || status === 400, `Unexpected status ${status}`);
  });

  // 4. Reject empty orders (no bids, no asks)
  await testCase('Multi-limit: reject empty orders', async () => {
    const { status, data } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        bids: [],
        asks: []
      })
    });
    verbose(`Status: ${status}, Data: ${JSON.stringify(data)}`);
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // 5. Reject exceeding MAX_ORDERS (10)
  await testCase('Multi-limit: reject >10 orders', async () => {
    const manyBids = Array.from({ length: 11 }, (_, i) => ({
      price: 50.0 - i * 0.1,
      size_lots: 1
    }));
    const { status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        bids: manyBids,
        asks: []
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400, `Expected 400 for >10 orders, got ${status}`);
  });

  // 6. Reject invalid price (zero)
  await testCase('Multi-limit: reject zero price', async () => {
    const { status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        bids: [{ price: 0, size_lots: 1 }],
        asks: []
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400, `Expected 400 for zero price, got ${status}`);
  });

  // 7. Reject invalid size_lots (zero)
  await testCase('Multi-limit: reject zero size_lots', async () => {
    const { status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        bids: [{ price: 50.0, size_lots: 0 }],
        asks: []
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400, `Expected 400 for zero size_lots, got ${status}`);
  });

  // 8. Reject invalid authority
  await testCase('Multi-limit: reject bad authority', async () => {
    const { status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: 'not-a-pubkey',
        symbol: 'SOL',
        bids: [{ price: 50.0, size_lots: 1 }],
        asks: []
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400, `Expected 400 for bad authority, got ${status}`);
  });

  // 9. Reject invalid symbol
  await testCase('Multi-limit: reject unknown symbol', async () => {
    const { status } = await apiCall('/api/tx/place-multi-limit-orders', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'DOESNOTEXIST',
        bids: [{ price: 50.0, size_lots: 1 }],
        asks: []
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400 || status === 404, `Expected 400/404 for unknown symbol, got ${status}`);
  });

  // -----------------------------------------------------------------------
  // POST /api/tx/cancel-stop-loss
  // -----------------------------------------------------------------------

  // 10. Valid cancel-stop-loss — less_than direction
  await testCase('Cancel-stop-loss: less_than direction', async () => {
    const { ok, data, status } = await apiCall('/api/tx/cancel-stop-loss', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        direction: 'less_than',
        subaccount_index: 0
      })
    });
    verbose(`Status: ${status}, Data: ${JSON.stringify(data)}`);
    // May return 200 (tx built) or 400 (no active TP/SL to cancel) — both valid
    assert(ok || status === 400, `Unexpected status ${status}`);
    if (ok) {
      assert(Array.isArray(data.instructions), 'Should return instructions array');
    }
  });

  // 11. Valid cancel-stop-loss — greater_than direction
  await testCase('Cancel-stop-loss: greater_than direction', async () => {
    const { ok, data, status } = await apiCall('/api/tx/cancel-stop-loss', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        direction: 'greater_than',
        subaccount_index: 0
      })
    });
    verbose(`Status: ${status}, Data: ${JSON.stringify(data)}`);
    assert(ok || status === 400, `Unexpected status ${status}`);
  });

  // 12. Short aliases — lt / gt
  await testCase('Cancel-stop-loss: lt alias', async () => {
    const { ok, status } = await apiCall('/api/tx/cancel-stop-loss', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        direction: 'lt'
      })
    });
    verbose(`Status: ${status}`);
    assert(ok || status === 400, `Unexpected status ${status} for lt alias`);
  });

  await testCase('Cancel-stop-loss: gt alias', async () => {
    const { ok, status } = await apiCall('/api/tx/cancel-stop-loss', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        direction: 'gt'
      })
    });
    verbose(`Status: ${status}`);
    assert(ok || status === 400, `Unexpected status ${status} for gt alias`);
  });

  // 13. Reject invalid direction
  await testCase('Cancel-stop-loss: reject bad direction', async () => {
    const { status } = await apiCall('/api/tx/cancel-stop-loss', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        direction: 'sideways'
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400, `Expected 400 for bad direction, got ${status}`);
  });

  // 14. Reject invalid authority
  await testCase('Cancel-stop-loss: reject bad authority', async () => {
    const { status } = await apiCall('/api/tx/cancel-stop-loss', {
      method: 'POST',
      body: JSON.stringify({
        authority: 'garbage',
        symbol: 'SOL',
        direction: 'less_than'
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400, `Expected 400 for bad authority, got ${status}`);
  });

  // 15. Isolated subaccount (index=1)
  await testCase('Cancel-stop-loss: isolated subaccount', async () => {
    const { ok, status } = await apiCall('/api/tx/cancel-stop-loss', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        direction: 'less_than',
        subaccount_index: 1
      })
    });
    verbose(`Status: ${status}`);
    assert(ok || status === 400, `Unexpected status ${status}`);
  });

  // 16. Isolated market order — unregistered subaccount (regression test)
  // The old handler used HTTP API pre-flight which 404'd on unregistered traders.
  // The local SDK builder auto-registers, so this should return 200 with instructions.
  await testCase('Isolated market order: unregistered subaccount builds TX', async () => {
    const { ok, data, status } = await apiCall('/api/tx/isolated-market-order', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        side: 'buy',
        size_lots: 1,
        subaccount_index: 99
      })
    });
    verbose(`Status: ${status}, Data: ${JSON.stringify(data)}`);
    assert(ok, `Expected 200 for unregistered sub=99, got ${status}: ${JSON.stringify(data)}`);
    assert(Array.isArray(data.instructions), 'Should return instructions array');
    // Should contain register + sync + market order instructions (3+)
    assert(data.instructions.length >= 2, `Expected 2+ instructions for auto-register, got ${data.instructions.length}`);
  });

  // 17. Isolated market order — missing subaccount_index returns 400
  await testCase('Isolated market order: reject missing subaccount_index', async () => {
    const { status } = await apiCall('/api/tx/isolated-market-order', {
      method: 'POST',
      body: JSON.stringify({
        authority: TEST_WALLET_PUBKEY,
        symbol: 'SOL',
        side: 'buy',
        size_lots: 1
      })
    });
    verbose(`Status: ${status}`);
    assert(status === 400, `Expected 400 for missing subaccount_index, got ${status}`);
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  log('\n=================================');
  log(`Results: ${results.passed}/${results.passed + results.failed} passed`);
  log('=================================');
  results.tests.forEach(t => {
    const icon = t.status === 'PASS' ? '✅' : '❌';
    log(`  ${icon} ${t.name} (${t.duration}ms)${t.error ? ' — ' + t.error : ''}`);
  });

  process.exit(results.failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
