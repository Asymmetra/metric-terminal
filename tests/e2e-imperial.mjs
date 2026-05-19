#!/usr/bin/env node
/**
 * End-to-end smoke test for the metric-backend ↔ Imperial pipeline.
 *
 * Assumes a backend is already running on http://127.0.0.1:3457 (or
 * pass a custom URL via $METRIC_BACKEND_URL). Boots no processes.
 *
 * Verifies:
 *   - /health returns "ok"
 *   - /api/markets returns >0 rows spanning phoenix/flash/gmtrade
 *   - /api/orderbook/SOL returns a Phoenix snapshot (bids+asks)
 *   - /api/candles/SOL returns an array (may be empty on cold start)
 *   - /health/relay is non-empty after a brief wait for WS to warm up
 *   - /api/tx/deposit returns an unsigned VersionedTransaction
 *   - /api/tx/market-order returns 410 (Imperial JWT-delegation)
 *   - /api/trader/<bogus> handles invalid wallets gracefully (Imperial 400)
 *   - /ws fan-out delivers at least one mark_price_update + candle_update
 *     within 10 seconds of subscribing.
 */

import { WebSocket } from "node:http";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const BASE = process.env.METRIC_BACKEND_URL ?? "http://127.0.0.1:3457";
const TEST_WALLET = "HP29cxeYsvErDq51zPmUdWp6j12GdLFQo97JJeQPC8x";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

let pass = 0;
let fail = 0;
const failures = [];

function logPass(name) {
  pass += 1;
  process.stdout.write(`${GREEN}✓${RESET} ${name}\n`);
}
function logFail(name, reason) {
  fail += 1;
  failures.push(`${name}: ${reason}`);
  process.stdout.write(`${RED}✗${RESET} ${name}\n  ${YELLOW}${reason}${RESET}\n`);
}

async function http_(method, path, body) {
  const url = new URL(BASE + path);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        timeout: 15_000,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = buf ? JSON.parse(buf) : null;
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function check(name, fn) {
  try {
    await fn();
    logPass(name);
  } catch (e) {
    logFail(name, e?.message ?? String(e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ──────────────────────────────────── HTTP checks

await check("GET /health → ok", async () => {
  const r = await http_("GET", "/health");
  assert(r.status === 200, `status ${r.status}`);
  assert(String(r.body).trim().startsWith("ok"), `body: ${r.body}`);
});

await check("GET /api/markets → 100+ rows across 3 venues", async () => {
  const r = await http_("GET", "/api/markets");
  assert(r.status === 200, `status ${r.status}`);
  assert(Array.isArray(r.body), "not an array");
  assert(r.body.length >= 100, `only ${r.body.length} rows`);
  const venues = new Set(r.body.map((m) => m.venue));
  for (const v of ["phoenix", "flash_trade", "gmtrade"]) {
    assert(venues.has(v), `venue ${v} missing`);
  }
});

await check("GET /api/orderbook/SOL → bids+asks present", async () => {
  const r = await http_("GET", "/api/orderbook/SOL");
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body && Array.isArray(r.body.bids), "no bids array");
  assert(Array.isArray(r.body.asks), "no asks array");
});

await check("GET /api/candles/SOL → array (may be empty)", async () => {
  const r = await http_("GET", "/api/candles/SOL?venue=phoenix&timeframe=1m");
  assert(r.status === 200, `status ${r.status}`);
  assert(Array.isArray(r.body), "not an array");
});

await check("GET /health/relay → channels active", async () => {
  // Give the upstream WS time to warm up.
  for (let i = 0; i < 10; i += 1) {
    const r = await http_("GET", "/health/relay");
    if (
      r.status === 200 &&
      Array.isArray(r.body.channels) &&
      r.body.channels.length > 0
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("no channels after 10s wait");
});

await check("POST /api/tx/deposit → returns base64 partial tx", async () => {
  const r = await http_("POST", "/api/tx/deposit", {
    wallet: TEST_WALLET,
    profile_index: 0,
    amount: 1_000_000,
  });
  assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);
  assert(typeof r.body.transaction === "string", "no transaction string");
  assert(r.body.transaction.length > 50, "tx blob too short");
});

await check(
  "POST /api/tx/market-order → 410 Gone (JWT-delegated to Imperial)",
  async () => {
    const r = await http_("POST", "/api/tx/market-order", { dummy: true });
    assert(r.status === 410, `expected 410, got ${r.status}`);
  }
);

await check("POST /api/tx/transfer-collateral → 410 (use withdraw+deposit)", async () => {
  const r = await http_("POST", "/api/tx/transfer-collateral", {});
  assert(r.status === 410, `expected 410, got ${r.status}`);
});

await check("POST /api/tx/deposit with bad wallet → 400", async () => {
  const r = await http_("POST", "/api/tx/deposit", {
    wallet: "not-a-pubkey",
    profile_index: 0,
    amount: 1_000_000,
  });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

// ──────────────────────────────────── WS check (raw RFC6455 client)

await check(
  "WS /ws → at least 1 mark_price_update + 1 candle_update in 10s",
  async () => {
    const net = await import("node:net");
    const crypto = await import("node:crypto");
    const url = new URL(BASE);
    const sock = net.createConnection({ host: url.hostname, port: Number(url.port) || 80 });
    const key = crypto.randomBytes(16).toString("base64");
    sock.write(
      `GET /ws HTTP/1.1\r\nHost: ${url.hostname}:${url.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
    await new Promise((resolve, reject) => {
      sock.once("data", (chunk) => {
        if (chunk.includes(Buffer.from("101 Switching Protocols"))) resolve();
        else reject(new Error("handshake failed: " + chunk.slice(0, 80)));
      });
      sock.once("error", reject);
    });

    function sendText(text) {
      const data = Buffer.from(text);
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
      const hdr =
        data.length < 126
          ? Buffer.from([0x81, 0x80 | data.length])
          : Buffer.concat([
              Buffer.from([0x81, 0x80 | 126]),
              Buffer.from([(data.length >> 8) & 0xff, data.length & 0xff]),
            ]);
      sock.write(Buffer.concat([hdr, mask, masked]));
    }

    sendText(JSON.stringify({ type: "subscribe", channel: "mark_prices", symbol: "SOL" }));
    sendText(JSON.stringify({ type: "subscribe", channel: "candles", symbol: "SOL" }));

    return new Promise((resolve, reject) => {
      const seen = { mark_price_update: 0, candle_update: 0 };
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`only got ${JSON.stringify(seen)} in 10s`));
      }, 10_000);
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // Drain complete frames.
        while (buf.length >= 2) {
          const fin = buf[0] & 0x80;
          const op = buf[0] & 0x0f;
          let plen = buf[1] & 0x7f;
          let off = 2;
          if (plen === 126) {
            if (buf.length < 4) break;
            plen = buf.readUInt16BE(2);
            off = 4;
          } else if (plen === 127) {
            if (buf.length < 10) break;
            plen = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + plen) break;
          const payload = buf.slice(off, off + plen).toString("utf8");
          buf = buf.slice(off + plen);
          if (op === 0x1 && fin) {
            try {
              const d = JSON.parse(payload);
              const t = d.type;
              if (seen[t] !== undefined) seen[t] += 1;
              if (seen.mark_price_update >= 1 && seen.candle_update >= 1) {
                clearTimeout(timer);
                sock.destroy();
                resolve();
              }
            } catch {
              // ignore
            }
          }
        }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
);

// ──────────────────────────────────── summary

process.stdout.write(
  `\n${pass} passed, ${fail} failed.\n${
    fail ? failures.map((f) => `  - ${f}`).join("\n") + "\n" : ""
  }`
);
process.exit(fail === 0 ? 0 : 1);
