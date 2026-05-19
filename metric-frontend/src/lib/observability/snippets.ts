/**
 * Multi-language code-snippet generation for every DataSource kind.
 *
 * The observability page exposes "show me how to consume this from $LANG"
 * for each row. Generators are pure functions of a `SourceDescriptor` so
 * they're trivially testable and live-update with the active symbol.
 *
 * Snippets are intentionally copy-pasteable as-is — no surrounding setup
 * code. Each one is the minimal code to receive one message / one
 * response from that exact source.
 */

import type { SourceDescriptor } from "./types";

export interface CodeSnippet {
  /** Language id for syntax highlighting (`ts`, `rust`, `bash`). */
  language: string;
  /** Display label on the tab. */
  label: string;
  /** Source code. */
  code: string;
}

const PHOENIX_WS_URL = "wss://perp-api.phoenix.trade/ws";
const PHOENIX_REST_URL = "https://perp-api.phoenix.trade";
const METRIC_WS_URL = "wss://ember-backend-q4nf.onrender.com/ws";
const METRIC_REST_URL = "https://ember-backend-q4nf.onrender.com";

function jsWsSubscribe(channel: string, payload: Record<string, unknown> = {}, channelFilter = channel): string {
  const sub = JSON.stringify({ channel, ...payload }, null, 0);
  return `// JavaScript / TypeScript (browser, Node, React Native)
const ws = new WebSocket("${PHOENIX_WS_URL}");

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "subscribe",
    subscription: ${sub},
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.channel === "${channelFilter}") {
    console.log(msg);
  }
};`;
}

function rustPhoenixWs(method: string, args: string, eventField: string): string {
  return `// Rust — using phoenix-rise = "=0.1.2" from crates.io
use phoenix_rise::PhoenixWSClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = PhoenixWSClient::new("${PHOENIX_WS_URL}", None)?;
    let (mut rx, _handle) = client.${method}(${args})?;
    while let Some(update) = rx.recv().await {
        println!("${eventField}: {:?}", update);
    }
    Ok(())
}`;
}

function curlRest(method: "GET" | "POST", url: string, body?: Record<string, unknown>): string {
  if (method === "GET") {
    return `# cURL — REST snapshot
curl -sS '${url}' | jq .`;
  }
  return `# cURL — POST
curl -sS -X POST '${url}' \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(body ?? {})}' | jq .`;
}

function jsFetch(url: string): string {
  return `// JavaScript / TypeScript fetch
const res = await fetch("${url}");
const data = await res.json();
console.log(data);`;
}

export function generateSnippets(d: SourceDescriptor): CodeSnippet[] {
  switch (d.kind) {
    // ── Phoenix WS ──────────────────────────────────────────────────────
    case "phoenix-ws-market":
      return [
        { language: "ts", label: "TypeScript", code: jsWsSubscribe("market", { symbol: d.symbol ?? "SOL" }) },
        { language: "rust", label: "Rust (SDK)", code: rustPhoenixWs("subscribe_to_market", `"${d.symbol ?? "SOL"}".to_string()`, "MarketStats") },
      ];
    case "phoenix-ws-all-mids":
      return [
        { language: "ts", label: "TypeScript", code: jsWsSubscribe("allMids") },
        { language: "rust", label: "Rust (SDK)", code: rustPhoenixWs("subscribe_to_all_mids", "", "AllMids") },
      ];
    case "phoenix-ws-funding":
      return [
        { language: "ts", label: "TypeScript", code: jsWsSubscribe("fundingRate", { symbol: d.symbol ?? "SOL" }) },
        { language: "rust", label: "Rust (SDK)", code: rustPhoenixWs("subscribe_to_funding_rate", `"${d.symbol ?? "SOL"}".to_string()`, "FundingRate") },
      ];
    case "phoenix-ws-orderbook":
      return [
        { language: "ts", label: "TypeScript", code: jsWsSubscribe("orderbook", { symbol: d.symbol ?? "SOL" }) },
        { language: "rust", label: "Rust (SDK)", code: rustPhoenixWs("subscribe_to_orderbook", `"${d.symbol ?? "SOL"}".to_string()`, "L2BookUpdate") },
      ];
    case "phoenix-ws-trades":
      return [
        { language: "ts", label: "TypeScript", code: jsWsSubscribe("trades", { symbol: d.symbol ?? "SOL" }) },
        { language: "rust", label: "Rust (SDK)", code: rustPhoenixWs("subscribe_to_trades", `"${d.symbol ?? "SOL"}".to_string()`, "Trades") },
      ];
    case "phoenix-ws-candles":
      return [
        { language: "ts", label: "TypeScript", code: jsWsSubscribe("candles", { symbol: d.symbol ?? "SOL", timeframe: d.timeframe ?? "1m" }) },
        { language: "rust", label: "Rust (SDK)", code: rustPhoenixWs("subscribe_to_candles", `"${d.symbol ?? "SOL"}".to_string(), Timeframe::Minute1`, "Candle") },
      ];

    // ── Phoenix REST ────────────────────────────────────────────────────
    case "phoenix-rest-exchange":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${PHOENIX_REST_URL}/exchange`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${PHOENIX_REST_URL}/exchange`) },
        { language: "rust", label: "Rust (SDK)", code: `use phoenix_rise::PhoenixHttpClient;\nlet client = PhoenixHttpClient::new("${PHOENIX_REST_URL}")?;\nlet snapshot = client.exchange().get_exchange().await?;` },
      ];
    case "phoenix-rest-orderbook":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${PHOENIX_REST_URL}/orderbook/${d.symbol ?? "SOL"}`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${PHOENIX_REST_URL}/orderbook/${d.symbol ?? "SOL"}`) },
      ];

    // ── Ember WS (backend-relayed) ──────────────────────────────────────
    case "metric-ws-stats":
    case "metric-ws-orderbook":
    case "metric-ws-trades":
    case "metric-ws-candles": {
      const channel = d.kind.replace("metric-ws-", "");
      return [
        { language: "ts", label: "TypeScript", code: `// JavaScript / TypeScript (consumes our backend relay)
const ws = new WebSocket("${METRIC_WS_URL}");
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "subscribe",
    channel: "${channel}",
    symbol: "${d.symbol ?? "SOL"}",
  }));
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.channel === "${channel}" && msg.symbol === "${d.symbol ?? "SOL"}") {
    console.log(msg.data);
  }
};`,
        },
      ];
    }

    // ── Ember REST ──────────────────────────────────────────────────────
    case "metric-rest-markets":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${METRIC_REST_URL}/api/markets`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${METRIC_REST_URL}/api/markets`) },
      ];
    case "metric-rest-orderbook":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${METRIC_REST_URL}/api/orderbook/${d.symbol ?? "SOL"}`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${METRIC_REST_URL}/api/orderbook/${d.symbol ?? "SOL"}`) },
      ];
    case "metric-rest-candles":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${METRIC_REST_URL}/api/candles/${d.symbol ?? "SOL"}?timeframe=1m&limit=100`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${METRIC_REST_URL}/api/candles/${d.symbol ?? "SOL"}?timeframe=1m&limit=100`) },
      ];
    case "metric-rest-health-memory":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${METRIC_REST_URL}/health/memory`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${METRIC_REST_URL}/health/memory`) },
      ];
    case "metric-rest-health-relay":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${METRIC_REST_URL}/health/relay`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${METRIC_REST_URL}/health/relay`) },
      ];
    case "metric-rest-health-ws":
      return [
        { language: "bash", label: "cURL", code: curlRest("GET", `${METRIC_REST_URL}/health/ws`) },
        { language: "ts", label: "TypeScript", code: jsFetch(`${METRIC_REST_URL}/health/ws`) },
      ];
  }
}
