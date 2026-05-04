// Comprehensive migration verification matrix for the phoenix-rise upgrade.
// Hits every REST endpoint, every WS channel, and every TX builder (no signing).
// Covers gaps not in e2e-smoke / new-endpoints-smoke.
//
// Usage: BACKEND_URL=http://localhost:3001 node migration-matrix.mjs

import WebSocket from "ws";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3001";
const WS_URL = (BACKEND.startsWith("https") ? BACKEND.replace("https", "wss") : BACKEND.replace("http", "ws")) + "/ws";
const PUB = process.env.AUTHORITY ?? "HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x";

const out = { pass: 0, fail: 0, fails: [] };
const ok = (name, info = "") => { out.pass++; console.log(`✅ ${name}${info ? ` — ${info}` : ""}`); };
const ko = (name, why) => { out.fail++; out.fails.push({ name, why }); console.log(`❌ ${name} — ${why}`); };

async function get(path) {
  const r = await fetch(BACKEND + path);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function post(path, body) {
  const r = await fetch(BACKEND + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ---------- REST data endpoints ----------
async function restMatrix() {
  console.log("\n=== REST data endpoints ===");
  const m = await get("/api/markets");
  if (m.status === 200 && Array.isArray(m.body) && m.body.length > 0) ok("/api/markets", `${m.body.length} markets`);
  else ko("/api/markets", `status=${m.status} body=${JSON.stringify(m.body).slice(0, 80)}`);

  const sym = m.body?.[0]?.symbol ?? "SOL";
  const ob = await get(`/api/orderbook/${sym}`);
  ob.status === 200 && Array.isArray(ob.body?.bids) && Array.isArray(ob.body?.asks)
    ? ok(`/api/orderbook/${sym}`, `bids=${ob.body.bids.length} asks=${ob.body.asks.length}`)
    : ko(`/api/orderbook/${sym}`, `status=${ob.status}`);

  const c = await get(`/api/candles/${sym}?timeframe=1m&limit=5`);
  c.status === 200 && Array.isArray(c.body) && c.body.length > 0
    ? ok(`/api/candles/${sym}`, `${c.body.length} candles, sample close=${c.body[0]?.close}`)
    : ko(`/api/candles/${sym}`, `status=${c.status} body=${JSON.stringify(c.body).slice(0, 100)}`);

  const t = await get(`/api/trader/${PUB}`);
  t.status === 200 && Array.isArray(t.body?.accounts)
    ? ok(`/api/trader/${PUB}`, `${t.body.accounts.length} subaccounts`)
    : ko(`/api/trader/${PUB}`, `status=${t.status} body=${JSON.stringify(t.body).slice(0, 100)}`);

  for (const sub of ["orders", "trades", "subaccounts", "funding", "pnl", "collateral-history"]) {
    const r = await get(`/api/trader/${PUB}/${sub}`);
    r.status === 200 ? ok(`/api/trader/${PUB}/${sub}`) : ko(`/api/trader/${PUB}/${sub}`, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 100)}`);
  }

  // Onboarding (proxy to perp-api)
  const ob2 = await get(`/api/onboard/check/${PUB}`);
  ob2.status === 200 && typeof ob2.body?.activated === "boolean"
    ? ok(`/api/onboard/check/${PUB}`, `activated=${ob2.body.activated}`)
    : ko(`/api/onboard/check/${PUB}`, `status=${ob2.status} body=${JSON.stringify(ob2.body).slice(0, 100)}`);

  // Leaderboard
  const lb = await get(`/api/leaderboard?period=1d&limit=5`);
  lb.status === 200 ? ok("/api/leaderboard", `traders=${(lb.body?.traders ?? []).length}`) : ko("/api/leaderboard", `status=${lb.status}`);
}

// ---------- TX builders (build-only, no signing) ----------
async function txMatrix() {
  console.log("\n=== TX builders (build-only) ===");

  const reqs = [
    ["/api/tx/market-order",            { authority: PUB, symbol: "SOL", side: "bid",  size_lots: 1 }],
    ["/api/tx/limit-order",             { authority: PUB, symbol: "SOL", side: "bid",  price: 50.0, size_lots: 1 }],
    ["/api/tx/cancel-orders",           { authority: PUB, symbol: "SOL", order_ids: [{ price: 50.0, order_sequence_number: 1 }] }],
    ["/api/tx/deposit",                 { authority: PUB, amount_usdc: 10 }],
    ["/api/tx/withdraw",                { authority: PUB, amount_usdc: 1 }],
    ["/api/tx/transfer-collateral",     { authority: PUB, from_subaccount_index: 0, to_subaccount_index: 1, amount_usdc: 5 }],
    ["/api/tx/register-subaccount",     { authority: PUB, subaccount_index: 1 }],
    ["/api/tx/place-multi-limit-orders",{ authority: PUB, symbol: "SOL",
                                           bids: [{ price: 50, size_lots: 1 }, { price: 49, size_lots: 1 }],
                                           asks: [{ price: 80, size_lots: 1 }, { price: 81, size_lots: 1 }] }],
    ["/api/tx/cancel-stop-loss",        { authority: PUB, symbol: "SOL", direction: "less_than" }],
    ["/api/tx/close-all-positions",     { authority: PUB, positions: [{ symbol: "SOL", side: "long", size_lots: 1, margin_mode: "cross", subaccount_index: 0 }] }],
    ["/api/tx/isolated-market-order",   { authority: PUB, symbol: "SOL", side: "bid", size_lots: 1, subaccount_index: 1, collateral_usdc: 5 }],
    ["/api/tx/isolated-limit-order",    { authority: PUB, symbol: "SOL", side: "bid", price: 50.0, size_lots: 1, subaccount_index: 1, collateral_usdc: 5 }],
  ];
  for (const [path, body] of reqs) {
    const r = await post(path, body);
    if (r.status === 200 && Array.isArray(r.body?.instructions) && r.body.instructions.length > 0) {
      ok(path, `${r.body.instructions.length} ix`);
    } else {
      ko(path, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 120)}`);
    }
  }
}

// ---------- Bracket leg semantics: bracket order should produce more ixs than naked ----------
async function bracketSemantics() {
  console.log("\n=== Bracket leg semantics ===");
  const naked = await post("/api/tx/market-order", { authority: PUB, symbol: "SOL", side: "bid", size_lots: 1 });
  const bracketed = await post("/api/tx/market-order", { authority: PUB, symbol: "SOL", side: "bid", size_lots: 1, stop_loss_price: 60.0, take_profit_price: 100.0 });
  if (naked.status === 200 && bracketed.status === 200) {
    const dn = naked.body.instructions.length;
    const db = bracketed.body.instructions.length;
    db > dn ? ok("market+SL+TP appends bracket ixs", `naked=${dn}ix, bracketed=${db}ix`) : ko("market+SL+TP appends bracket ixs", `naked=${dn}ix == bracketed=${db}ix`);
  } else {
    ko("bracket semantics", `naked=${naked.status} bracketed=${bracketed.status}`);
  }
}

// ---------- Onboarding routes (both invite paths) ----------
async function onboardingMatrix() {
  console.log("\n=== Onboarding (referral + access code) ===");
  // Both routes should reject bogus codes with 400 invalid_code:* — and route
  // to their distinct upstream Phoenix endpoints (visible in the error body).
  const ref = await post("/api/onboard/activate-referral", { authority: PUB, referral_code: "NOPE-XYZ" });
  ref.status === 400 && JSON.stringify(ref.body).includes("invalid_referral_code")
    ? ok("activate-referral routes to /v1/invite/activate-with-referral", "rejected with invalid_referral_code")
    : ko("activate-referral routes correctly", `status=${ref.status} body=${JSON.stringify(ref.body).slice(0, 120)}`);

  const acc = await post("/api/onboard/activate-access-code", { authority: PUB, code: "NOPE-XYZ" });
  acc.status === 400 && JSON.stringify(acc.body).includes("invalid_invite_code")
    ? ok("activate-access-code routes to /v1/invite/activate", "rejected with invalid_invite_code")
    : ko("activate-access-code routes correctly", `status=${acc.status} body=${JSON.stringify(acc.body).slice(0, 120)}`);

  // Negative validation
  const empty = await post("/api/onboard/activate-access-code", { authority: PUB, code: "  " });
  empty.status === 400 ? ok("access-code rejects empty/whitespace", `status=${empty.status}`) : ko("access-code rejects empty", `status=${empty.status}`);

  const badAuth = await post("/api/onboard/activate-referral", { authority: "not-a-pubkey", referral_code: "X" });
  badAuth.status === 400 ? ok("referral rejects bad authority", `status=${badAuth.status}`) : ko("referral rejects bad authority", `status=${badAuth.status}`);
}

// ---------- Validation guardrails (negative tests) ----------
async function guardrails() {
  console.log("\n=== Validation guardrails (expect 4xx) ===");
  const cases = [
    ["isolated-market-order missing subaccount_index", "/api/tx/isolated-market-order", { authority: PUB, symbol: "SOL", side: "bid", size_lots: 1 }],
    ["limit-order with TP/SL rejected",                 "/api/tx/limit-order",          { authority: PUB, symbol: "SOL", side: "bid", price: 50, size_lots: 1, stop_loss_price: 40 }],
    ["unknown symbol rejected",                          "/api/tx/market-order",         { authority: PUB, symbol: "FAKE", side: "bid", size_lots: 1 }],
    ["bad authority rejected",                           "/api/tx/market-order",         { authority: "not-a-pubkey", symbol: "SOL", side: "bid", size_lots: 1 }],
    ["zero size rejected",                               "/api/tx/market-order",         { authority: PUB, symbol: "SOL", side: "bid", size_lots: 0 }],
    ["isolated-only market on cross-margin rejected",    "/api/tx/market-order",         { authority: PUB, symbol: "SKR", side: "bid", size_lots: 1 }],
  ];
  for (const [name, path, body] of cases) {
    const r = await post(path, body);
    r.status >= 400 && r.status < 500 ? ok(name, `status=${r.status}`) : ko(name, `expected 4xx, got status=${r.status}`);
  }
}

// ---------- WS channels: subscribe and verify messages arrive ----------
async function wsChannels() {
  console.log("\n=== WS channels (one message per channel) ===");
  const channels = [
    { name: "orderbook", subscribe: { type: "subscribe", channel: "orderbook", symbol: "SOL" }, predicate: (m) => m.channel === "orderbook" && Array.isArray(m.data?.bids) },
    { name: "stats",     subscribe: { type: "subscribe", channel: "stats",     symbol: "SOL" }, predicate: (m) => m.channel === "stats"     && typeof m.data?.mark_price === "number" },
    { name: "candles",   subscribe: { type: "subscribe", channel: "candles",   symbol: "SOL" }, predicate: (m) => m.channel === "candles"   && m.data?.candle?.open != null },
    { name: "trades",    subscribe: { type: "subscribe", channel: "trades",    symbol: "SOL" }, predicate: (m) => m.channel === "trades"    && Array.isArray(m.data?.trades) && m.data.trades.length > 0 },
    { name: "trader_margin", subscribe: { type: "subscribe", channel: "trader_margin", authority: PUB }, predicate: (m) => m.channel === "trader_margin" },
  ];

  for (const ch of channels) {
    await new Promise((resolve) => {
      const ws = new WebSocket(WS_URL);
      const start = Date.now();
      const TO = ch.name === "trades" ? 90_000 : 30_000;
      const timer = setTimeout(() => {
        ko(`ws:${ch.name}`, `no matching message in ${TO}ms`);
        ws.close();
        resolve();
      }, TO);
      ws.on("open", () => ws.send(JSON.stringify(ch.subscribe)));
      ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (ch.predicate(msg)) {
          clearTimeout(timer);
          ok(`ws:${ch.name}`, `+${Date.now() - start}ms`);
          ws.close();
          resolve();
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        ko(`ws:${ch.name}`, `ws-error ${err.message}`);
        resolve();
      });
    });
  }
}

(async () => {
  console.log(`Backend: ${BACKEND}`);
  console.log(`WS:      ${WS_URL}`);
  console.log(`Wallet:  ${PUB}`);
  await restMatrix();
  await txMatrix();
  await bracketSemantics();
  await onboardingMatrix();
  await guardrails();
  await wsChannels();

  console.log(`\n=== Summary: ${out.pass} pass, ${out.fail} fail ===`);
  if (out.fail > 0) {
    for (const f of out.fails) console.log(`  - ${f.name}: ${f.why}`);
    process.exit(1);
  }
})();
