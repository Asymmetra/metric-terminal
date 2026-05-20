#!/usr/bin/env node
/**
 * Minimal Imperial mock that responds to the endpoints the metric-backend
 * proxies. Used by tests/integration-against-mock.mjs to verify the
 * backend proxy paths without depending on api.imperial.space uptime.
 *
 *   /api/v1/phoenix/markets     → 1 row
 *   /api/v1/flash/markets       → 1 row
 *   /api/v1/gmtrade/markets     → 1 row
 *   /api/v1/phoenix/depth       → {snapshots: {SOL: {bids:[],asks:[]}}}
 *   /api/v1/positions           → empty position list
 *   /api/v1/trades              → empty position list
 *   /api/v1/mark-prices         → 1 row
 *   /api/v1/deposit/build-tx    → echo back as base64 of a known string
 *
 * Run: node tests/mock-imperial-server.mjs   (binds 127.0.0.1:9001)
 */

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? "9001");

const positionList = {
  count: 0,
  totalCount: 0,
  dataList: [],
  lifetimePnlUsd: "0",
  lifetimeFeesUsd: "0",
  lifetimeCollateralUsd: "0",
  lifetimeFeeBreakdown: {
    interest: "0",
    jupiterFee: "0",
    platformFee: "0",
    proOrderFee: "0",
    slippage: "0",
    swapFee: "0",
  },
};

const handlers = new Map([
  [
    "GET /api/v1/phoenix/markets",
    () => [
      {
        symbol: "SOL",
        assetId: 0,
        underwriter: "phoenix",
        subaccountIndex: 0,
        maxLeverage: 15.0,
        tickSizeInQuoteLotsPerBaseLot: 1000,
        makerFeeMicro: 100,
        takerFeeMicro: 200,
        activeTraderBuffer: [],
        baseLotsDecimals: -3,
        globalTraderIndex: [],
        maxSizeBaseLots: 1000000,
        orderbook: "OrderbookPda1111111111111111111111111111111",
        perpAssetMap: "AssetMap1111111111111111111111111111111111",
        splineCollection: "Spline111111111111111111111111111111111",
        withdrawQueue: "WithdrawQ111111111111111111111111111111",
      },
    ],
  ],
  [
    "GET /api/v1/flash/markets",
    () => [
      {
        symbol: "SOL",
        underwriter: "flash_trade",
        side: "long",
        maxLeverage: 120.0,
        allowOpenPosition: true,
        allowClosePosition: true,
        tokenDecimals: 9,
        collateralCustody: "x",
        collateralCustodyTokenAccount: "x",
        collateralMint: "x",
        collateralOracle: "x",
        marketAddress: "x",
        poolAddress: "x",
        poolName: "x",
        priceExponent: -8,
        targetCustody: "x",
        targetMint: "x",
        targetOracle: "x",
      },
    ],
  ],
  [
    "GET /api/v1/gmtrade/markets",
    () => [
      {
        symbol: "SOL",
        underwriter: "gmtrade",
        closed: false,
        indexTokenDecimals: 9,
        indexTokenMint: "x",
        longTokenMint: "x",
        longTokenVault: "x",
        market: "x",
        marketTokenMint: "x",
        oracle: "x",
        shortTokenMint: "x",
        shortTokenVault: "x",
      },
    ],
  ],
  [
    "GET /api/v1/phoenix/depth",
    () => ({ snapshots: { SOL: { bids: [], asks: [], symbol: "SOL", mid: 0, fetchedAt: Date.now() } } }),
  ],
  [
    "GET /api/v1/positions",
    () => positionList,
  ],
  [
    "GET /api/v1/trades",
    () => positionList,
  ],
  [
    "GET /api/v1/mark-prices",
    () => ({
      rows: [
        {
          symbol: "SOL",
          phoenix: {
            price: 100.0,
            source: "phoenix_orderbook_ws",
            fetchedAtUnixMs: Date.now(),
          },
          flash: null,
          gmtrade: null,
          jupiter: null,
        },
      ],
    }),
  ],
]);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url.split("?")[0];
    const key = `${req.method} ${url}`;
    if (req.method === "POST" && url === "/api/v1/deposit/build-tx") {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.wallet || typeof parsed.amount !== "number") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
          return;
        }
        const fake = Buffer.from(`MOCK:${parsed.mode}:${parsed.amount}:${parsed.wallet}`).toString("base64");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ transaction: fake }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }
    const handler = handlers.get(key);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `mock has no handler for ${key}` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(handler()));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock imperial listening on http://127.0.0.1:${PORT}`);
});
