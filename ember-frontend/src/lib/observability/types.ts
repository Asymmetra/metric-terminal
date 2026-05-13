/**
 * Data-source model for the observability page.
 *
 * Every observed channel/endpoint is normalized into a `DataSource` so the
 * UI can render them uniformly: same status indicators, same cadence
 * tracking, same code-snippet machinery. The hook in
 * `useObservability.ts` is the single owner of all sources.
 */

export type SourceCategory =
  | "phoenix-ws"     // wss://perp-api.phoenix.trade/ws — direct Phoenix stream
  | "phoenix-rest"   // https://perp-api.phoenix.trade — direct Phoenix REST
  | "ember-ws"       // our backend's /ws — backend-relayed feeds
  | "ember-rest";    // our backend's /api/* — REST endpoints

/**
 * The semantic kind of a source. Drives snippet generation and the
 * payload-shape contract. Adding a new kind = registering a generator
 * in snippets.ts.
 */
export type SourceKind =
  // ── Phoenix WS channels (direct) ────────────────────────────────────
  | "phoenix-ws-market"      // subscribe_to_market(symbol): oracle/mark/mid + funding
  | "phoenix-ws-all-mids"    // subscribe_to_all_mids: global heartbeat
  | "phoenix-ws-funding"     // subscribe_to_funding_rate(symbol)
  | "phoenix-ws-orderbook"   // subscribe_to_orderbook(symbol): L2 snapshots
  | "phoenix-ws-trades"      // subscribe_to_trades(symbol): print stream
  | "phoenix-ws-candles"     // subscribe_to_candles(symbol, timeframe)
  // ── Phoenix REST (direct, polled) ───────────────────────────────────
  | "phoenix-rest-exchange"  // GET /exchange — markets snapshot
  | "phoenix-rest-orderbook" // GET /orderbook/{symbol}
  // ── Ember WS (backend-relayed equivalents) ──────────────────────────
  | "ember-ws-stats"
  | "ember-ws-orderbook"
  | "ember-ws-trades"
  | "ember-ws-candles"
  // ── Ember REST ──────────────────────────────────────────────────────
  | "ember-rest-markets"     // GET /api/markets
  | "ember-rest-orderbook"   // GET /api/orderbook/{symbol}
  | "ember-rest-candles"     // GET /api/candles/{symbol}
  | "ember-rest-health-memory" // GET /health/memory
  | "ember-rest-health-relay"  // GET /health/relay
  | "ember-rest-health-ws";    // GET /health/ws

export type SourceStatus =
  | "healthy"   // last update recent + cadence within budget
  | "degraded"  // last update somewhat old or cadence stretched
  | "stale"     // no recent update at all
  | "error"     // last attempt errored
  | "idle";     // never started (e.g. paused, awaiting symbol list)

/** Rolling latency / activity stats per source. */
export interface SourceStats {
  /** Total messages or successful polls since the most recent reset. */
  count: number;
  /** Approx count of arrivals in the last 60s window. */
  count60s: number;
  /** Messages per second over the last 60s. */
  rate60s: number;
  /** performance.now() timestamp of the last successful arrival. */
  lastUpdateAtMs: number | null;
  /** Seconds since lastUpdateAtMs, recomputed at flush time. */
  ageSec: number | null;
  /** Inter-arrival percentile in ms over the rolling window. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Worst gap seen in the window. */
  maxMs: number | null;
  /** Number of failed polls / WS errors since reset. */
  errorCount: number;
  lastErrorAtMs: number | null;
  lastErrorMessage: string | null;
}

/** Static-ish description of a source — what it is, where it lives. */
export interface SourceDescriptor {
  /** Canonical key e.g. "phoenix-ws:market:SOL". Stable across reloads. */
  id: string;
  kind: SourceKind;
  category: SourceCategory;
  /** Short label for table rows: "SOL — market" or "Health · memory". */
  label: string;
  /** Tooltip / detail-tray description of what this returns + cadence notes. */
  description: string;
  /** URL or wss:// endpoint this source uses. */
  endpoint: string;
  /** Subscribe / poll cadence target in ms. For WS this is heuristic only. */
  expectedCadenceMs?: number;
  /** Symbol context, if relevant. */
  symbol?: string;
  /** Wallet pubkey context, if relevant. */
  pubkey?: string;
  /** Timeframe (for candles). */
  timeframe?: string;
}

/** Hydrated source: descriptor + live stats + latest payload. */
export interface DataSource extends SourceDescriptor {
  stats: SourceStats;
  status: SourceStatus;
  /** Most recently received payload (parsed JSON or whatever). */
  latestPayload: unknown;
  /**
   * Recent payloads with arrival timestamps, capped at HISTORY_LIMIT.
   * Kept in memory while the page is open + persisted to localStorage so
   * a refresh doesn't wipe the visible context.
   */
  recentPayloads: Array<{ tMs: number; payload: unknown }>;
}

/** Maximum payloads kept per source in-memory and in localStorage. */
export const HISTORY_LIMIT = 100;

/** Maximum interarrival samples used to compute percentiles. */
export const ARRIVAL_SAMPLE_LIMIT = 256;
