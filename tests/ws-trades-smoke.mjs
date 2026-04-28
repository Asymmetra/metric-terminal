// Smoke test: confirm trades stream over WS post-migration.
// Subscribes to trades:SOL, waits up to 90s for ≥1 trade message.
// Exit 0 on success, non-zero on timeout or error.

import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3001/ws";
const SYMBOL = process.env.SYMBOL ?? "SOL";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 90_000);

const ws = new WebSocket(WS_URL);
let tradesSeen = 0;
let firstTradeAt = null;
let connectedAt = null;

const start = Date.now();
const timer = setTimeout(() => {
  console.error(
    `[FAIL] No trades received for ${SYMBOL} within ${TIMEOUT_MS}ms (connected at ${connectedAt ? `+${connectedAt - start}ms` : "never"}).`,
  );
  ws.close();
  process.exit(1);
}, TIMEOUT_MS);

ws.on("open", () => {
  connectedAt = Date.now();
  console.log(`[connect] ws open at +${connectedAt - start}ms`);
  ws.send(
    JSON.stringify({
      type: "subscribe",
      channel: "trades",
      symbol: SYMBOL,
    }),
  );
  console.log(`[subscribe] trades:${SYMBOL}`);
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.channel === "trades" && msg.data?.trades?.length) {
    if (firstTradeAt === null) {
      firstTradeAt = Date.now();
      console.log(
        `[first-trade] +${firstTradeAt - start}ms — ${msg.data.trades.length} trade(s)`,
      );
    }
    tradesSeen += msg.data.trades.length;
    if (tradesSeen >= 1) {
      clearTimeout(timer);
      console.log(
        `[OK] received ${tradesSeen} trade(s) on ${SYMBOL}. Sample: ${JSON.stringify(msg.data.trades[0])}`,
      );
      ws.close();
      process.exit(0);
    }
  }
});

ws.on("error", (err) => {
  console.error(`[ws-error] ${err.message}`);
  clearTimeout(timer);
  process.exit(2);
});

ws.on("close", () => {
  if (tradesSeen === 0) {
    console.error(`[FAIL] WS closed before receiving any trades`);
    process.exit(3);
  }
});
