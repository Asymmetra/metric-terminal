"use client";

import { API_V1, IMPERIAL_API_URL } from "./config";
import type {
  BalancesResponse,
  BatchRequest,
  BatchResponse,
  CancelRequest,
  CollateralRequest,
  ConnectRequest,
  ConnectResponse,
  DepositRequest,
  DepositResponse,
  ExchangeRequest,
  ExchangeResponse,
  FundingHistoryResponse,
  FundingRateRow,
  ImperialStatus,
  MarketsResponse,
  MarkPriceRow,
  OpenInterestResponse,
  OrderHistoryResponse,
  OrderRequest,
  OrderResponse,
  PassthroughOrdersResponse,
  PnlHistoryPoint,
  PointsResponse,
  PositionList,
  RegisterPhoenixResponse,
  RouteResponse,
  StatsSummaryResponse,
  SyncSweepResponse,
  ApiTouchPosition,
  TouchDealRow,
  TouchMarketRow,
  UpdateRequest,
  VenueTag,
  VolumeResponse,
} from "./types";
import { clearJwt, loadJwt, saveJwt } from "./jwt";
import type { SignerProvider } from "../wallet/types";
import { SignerNotReadyError } from "../wallet/types";

export class ImperialError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = "ImperialError";
  }
}

export class ImperialClient {
  private readonly base = IMPERIAL_API_URL + API_V1;

  // ────────────────────────────────────────────── auth flow

  /**
   * Run the connect + exchange handshake and return a fresh JWT.
   *
   * Caller is responsible for passing this to one ImperialClient call site
   * via `withJwt(...)` or for invoking ensureAuth() which caches in
   * localStorage and reuses across requests.
   */
  async connect(
    signer: SignerProvider
  ): Promise<{ jwt: string; expiresAt: number }> {
    if (!signer.publicKey) throw new SignerNotReadyError();
    const wallet = signer.publicKey;
    const nonce = makeNonce();
    const message = `imperial:mobile-connect:${wallet}:${nonce}`;

    const { signatureBase58 } = await signer.signMessage(message);

    const connect = await this.post<ConnectRequest, ConnectResponse>(
      "/mobile/connect",
      { wallet, message, signature: signatureBase58 }
    );
    const exchange = await this.post<ExchangeRequest, ExchangeResponse>(
      "/mobile/exchange",
      { code: connect.code }
    );
    saveJwt(wallet, exchange.jwt, exchange.expiresAt);
    return { jwt: exchange.jwt, expiresAt: exchange.expiresAt };
  }

  /**
   * Return a valid JWT for `wallet`, signing through the handshake if
   * the cached one is missing or about to expire.
   */
  async ensureAuth(signer: SignerProvider): Promise<string> {
    if (!signer.publicKey) throw new SignerNotReadyError();
    const cached = loadJwt(signer.publicKey);
    if (cached) return cached;
    const fresh = await this.connect(signer);
    return fresh.jwt;
  }

  async revoke(jwt: string, wallet: string): Promise<void> {
    await this.post<unknown, { success: boolean }>(
      "/mobile/revoke",
      {},
      jwt
    );
    clearJwt(wallet);
  }

  // ────────────────────────────────────────────── trading (auth)

  placeOrder(req: OrderRequest, jwt: string): Promise<OrderResponse> {
    return this.post("/mobile/orders", req, jwt);
  }
  placeBatch(req: BatchRequest, jwt: string): Promise<BatchResponse> {
    return this.post("/mobile/orders/batch", req, jwt);
  }
  cancelOrder(req: CancelRequest, jwt: string): Promise<OrderResponse> {
    return this.post("/mobile/orders/cancel", req, jwt);
  }
  updateOrder(req: UpdateRequest, jwt: string): Promise<OrderResponse> {
    return this.post("/mobile/orders/update", req, jwt);
  }
  adjustCollateral(req: CollateralRequest, jwt: string): Promise<OrderResponse> {
    return this.post("/mobile/orders/collateral", req, jwt);
  }
  getBalances(jwt: string): Promise<BalancesResponse> {
    return this.get("/mobile/balances", jwt);
  }

  /**
   * Per-profile Flash V2 `UserDepositLedger` balances. Read-only; needs the JWT.
   *
   * IMPORTANT: `availableUsdc` is NOT reclaimable/spendable collateral — empirically
   * it behaves like cumulative STAGED volume, not a withdrawable balance. The
   * "V2 collateral reuse" change that treated it as reclaimable (profile-free deposit
   * sizing) was REVERTED in 6c3affa; do not re-introduce profile-free sizing from this.
   *
   * Its ONLY safe consumer is the flash_v2 settle gate in trade-flow, which uses it
   * purely as a relative DELTA target (`availableBefore + deposit * 0.97`) — delta-safe
   * regardless of the field's absolute meaning. Do not treat it as a withdrawable amount.
   */
  getV2Balance(jwt: string): Promise<{
    wallet: string;
    profiles: { profileIndex: number; profilePda: string; availableUsdc: number }[];
  }> {
    return this.get("/mobile/v2/balance", jwt);
  }

  /**
   * Build a sponsored, partially-signed deposit/withdraw VersionedTransaction.
   * No JWT required — keyed on the wallet field. Caller hands the returned
   * base64 to SignerProvider.signAndSendTransaction.
   */
  buildDepositTx(req: DepositRequest): Promise<DepositResponse> {
    return this.post("/deposit/build-tx", req);
  }

  /**
   * Sweep a profile's non-USDC residue (WSOL/WBTC/WETH left over from closing a
   * token-collateralized position) back to USDC, routed to the user wallet.
   * Idempotent; rate-limited ~10s per profile. No JWT required. Call after a
   * full Decrease that closes a non-USDC-collateralized position.
   */
  syncProfileSweep(wallet: string, profileIndex: number): Promise<SyncSweepResponse> {
    return this.post(
      `/passthrough/users/${encodeURIComponent(wallet)}/profiles/${profileIndex}/sync`,
      {}
    );
  }

  /**
   * Optional Phoenix pre-activation under Imperial's referral. `/mobile/orders`
   * already auto-activates on first use, so this only warms the cache before a
   * latency-sensitive first Phoenix order. Unauthenticated + idempotent.
   */
  registerPhoenix(wallet: string, profileIndex = 0): Promise<RegisterPhoenixResponse> {
    return this.post("/phoenix/register", { wallet, profileIndex });
  }

  // ────────────────────────────────────────────── reads (no auth)

  getPositions(walletAddress: string): Promise<PositionList> {
    return this.get(`/positions?walletAddress=${encodeURIComponent(walletAddress)}`);
  }
  getTrades(
    walletAddress: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<PositionList> {
    const qs = new URLSearchParams({ walletAddress });
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.offset) qs.set("offset", String(opts.offset));
    return this.get(`/trades?${qs.toString()}`);
  }
  getFundingRates(): Promise<{ rows: FundingRateRow[] }> {
    return this.get("/funding-rates");
  }
  getMarkPrices(): Promise<{ rows: MarkPriceRow[] }> {
    return this.get("/mark-prices");
  }
  getRoute(query: {
    asset: string;
    side: "long" | "short";
    notional: number;
    desiredLeverage: number;
    wallet?: string;
    profileIndex?: number;
    stickyVenue?: VenueTag;
  }): Promise<RouteResponse> {
    const qs = new URLSearchParams();
    qs.set("asset", query.asset);
    qs.set("side", query.side);
    qs.set("notional", String(query.notional));
    qs.set("desiredLeverage", String(query.desiredLeverage));
    if (query.wallet) qs.set("wallet", query.wallet);
    if (query.profileIndex !== undefined) qs.set("profileIndex", String(query.profileIndex));
    if (query.stickyVenue) qs.set("stickyVenue", query.stickyVenue);
    return this.get(`/route?${qs.toString()}`);
  }
  getPriorityFee(): Promise<{ priority_fee: number }> {
    return this.get("/priority-fee");
  }
  /** Component health. `orderBot.status === "unhealthy"` ⇒ no order can place. */
  getStatus(): Promise<ImperialStatus> {
    return this.get("/status");
  }

  /**
   * Cumulative realized-PnL curve for a wallet, bucketed at `resolution`
   * (e.g. "1m" / "1h" / "1d"). `since`/`until` are unix-second bounds;
   * `underwriter` filters to one venue. No auth.
   */
  getPnlHistory(
    walletAddress: string,
    resolution: string,
    opts: { since?: number; until?: number; underwriter?: string } = {}
  ): Promise<PnlHistoryPoint[]> {
    const qs = new URLSearchParams({ walletAddress, resolution });
    if (opts.since !== undefined) qs.set("since", String(opts.since));
    if (opts.until !== undefined) qs.set("until", String(opts.until));
    if (opts.underwriter) qs.set("underwriter", opts.underwriter);
    return this.get(`/pnl-history?${qs.toString()}`);
  }

  /** Protocol-wide headline stats (24h/7d/all volume, OI, active traders). No auth. */
  getStatsSummary(): Promise<StatsSummaryResponse> {
    return this.get("/stats/summary");
  }
  /** Per-market volume + OI breakdown, optionally scoped to `period`. No auth. */
  getStatsMarkets(period?: string): Promise<MarketsResponse> {
    const qs = new URLSearchParams();
    if (period) qs.set("period", period);
    const q = qs.toString();
    return this.get(`/stats/markets${q ? `?${q}` : ""}`);
  }
  /** Time-bucketed volume series. No auth. */
  getStatsVolume(
    opts: { period?: string; grouping?: string; venue?: string } = {}
  ): Promise<VolumeResponse> {
    const qs = new URLSearchParams();
    if (opts.period) qs.set("period", opts.period);
    if (opts.grouping) qs.set("grouping", opts.grouping);
    if (opts.venue) qs.set("venue", opts.venue);
    const q = qs.toString();
    return this.get(`/stats/volume${q ? `?${q}` : ""}`);
  }
  /** Open interest grouped by venue/market/etc. No auth. */
  getStatsOpenInterest(grouping?: string): Promise<OpenInterestResponse> {
    const qs = new URLSearchParams();
    if (grouping) qs.set("grouping", grouping);
    const q = qs.toString();
    return this.get(`/stats/open-interest${q ? `?${q}` : ""}`);
  }

  /**
   * Resting/queued orders for a wallet from the passthrough indexer. Query
   * param is `profile_index` (snake_case) on this endpoint. No auth.
   */
  getOpenOrders(
    wallet: string,
    opts: { status?: string; limit?: number; profileIndex?: number } = {}
  ): Promise<PassthroughOrdersResponse> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.profileIndex !== undefined) qs.set("profile_index", String(opts.profileIndex));
    const q = qs.toString();
    return this.get(
      `/passthrough/users/${encodeURIComponent(wallet)}/orders${q ? `?${q}` : ""}`
    );
  }

  /**
   * Closed/settled order history for a wallet (`displayStatus` is the derived
   * user-facing status; `status` the raw DB one). USD fields are µUSD strings,
   * prices 1e9-scale strings. No auth.
   */
  getOrderHistory(
    walletAddress: string,
    opts: {
      limit?: number;
      offset?: number;
      market?: string;
      underwriter?: string;
      side?: string;
      status?: string;
      category?: string;
      from?: number;
      to?: number;
    } = {}
  ): Promise<OrderHistoryResponse> {
    const qs = new URLSearchParams({ walletAddress });
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
    if (opts.market) qs.set("market", opts.market);
    if (opts.underwriter) qs.set("underwriter", opts.underwriter);
    if (opts.side) qs.set("side", opts.side);
    if (opts.status) qs.set("status", opts.status);
    if (opts.category) qs.set("category", opts.category);
    if (opts.from !== undefined) qs.set("from", String(opts.from));
    if (opts.to !== undefined) qs.set("to", String(opts.to));
    return this.get(`/order-history?${qs.toString()}`);
  }

  /**
   * Funding/borrow settlement history for a wallet. `amount`/aggregates are
   * signed µUSD strings (positive = trader paid). No auth.
   */
  getFundingHistory(
    walletAddress: string,
    opts: {
      limit?: number;
      offset?: number;
      market?: string;
      underwriter?: string;
      side?: string;
      direction?: string;
      from?: number;
      to?: number;
    } = {}
  ): Promise<FundingHistoryResponse> {
    const qs = new URLSearchParams({ walletAddress });
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
    if (opts.market) qs.set("market", opts.market);
    if (opts.underwriter) qs.set("underwriter", opts.underwriter);
    if (opts.side) qs.set("side", opts.side);
    if (opts.direction) qs.set("direction", opts.direction);
    if (opts.from !== undefined) qs.set("from", String(opts.from));
    if (opts.to !== undefined) qs.set("to", String(opts.to));
    return this.get(`/funding-history?${qs.toString()}`);
  }

  // ────────────────────────────────────────────── imperial touch (no auth)

  /**
   * All touch markets — one row per underlying × tenor (distinguish by
   * `config.cohortWindowSecs`: 86400=24h, 3600=1h, 300=5m). `halted: true` ⇒
   * render read-only. No auth.
   */
  getTouchMarkets(): Promise<TouchMarketRow[]> {
    return this.get("/touch/markets");
  }
  /**
   * Ranked barrier quotes (±1/2/3/5/8% both sides, top 12, cached ~60s so
   * `askBps` is indicative). Optionally scoped to one `marketId`. No auth.
   */
  getTouchDeals(marketId?: number): Promise<TouchDealRow[]> {
    const q = marketId !== undefined ? `?marketId=${marketId}` : "";
    return this.get(`/touch/deals${q}`);
  }
  /**
   * A wallet's touch positions (open first, then finished newest-first, cap 200).
   * NOT on /positions or /ws — POLL (~3s). No auth.
   */
  getTouchPositions(walletAddress: string): Promise<ApiTouchPosition[]> {
    return this.get(`/touch/positions?walletAddress=${encodeURIComponent(walletAddress)}`);
  }

  // ────────────────────────────────────────────── points (auth)

  /**
   * Imperial season points for a wallet. REQUIRES the JWT (401 without it).
   * `seasonName` is null when no season is live (points then 0).
   */
  getPoints(walletAddress: string, jwt: string): Promise<PointsResponse> {
    return this.get(
      `/mobile/points?walletAddress=${encodeURIComponent(walletAddress)}`,
      jwt
    );
  }

  // ────────────────────────────────────────────── plumbing

  private async get<R>(path: string, jwt?: string): Promise<R> {
    const res = await fetch(this.base + path, {
      method: "GET",
      headers: this.headers(jwt),
    });
    return this.parse<R>(res);
  }

  private async post<Q, R>(path: string, body: Q, jwt?: string): Promise<R> {
    const res = await fetch(this.base + path, {
      method: "POST",
      headers: this.headers(jwt),
      body: JSON.stringify(body),
    });
    return this.parse<R>(res);
  }

  private headers(jwt?: string): HeadersInit {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (jwt) h["authorization"] = `Bearer ${jwt}`;
    return h;
  }

  private async parse<R>(res: Response): Promise<R> {
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON body
    }
    if (!res.ok) {
      const msg =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : text || `Imperial ${res.status}`;
      throw new ImperialError(res.status, parsed, msg);
    }
    return parsed as R;
  }
}

/** Singleton — fine since ImperialClient is stateless. */
export const imperial = new ImperialClient();

function makeNonce(): string {
  // Imperial's order bot requires the nonce to parse as u64 and be within
  // ±5 minutes of now (seconds or ms). Hex/UUID nonces produce a 400
  // "Invalid nonce format" inside the bot, which the API surfaces as a
  // generic 401 "Failed to generate mobile session" (see mobile.rs:186-190
  // vs http.rs:564-588 in Imperial). Date.now() is unix milliseconds —
  // canonical client uses the same.
  return Date.now().toString();
}
