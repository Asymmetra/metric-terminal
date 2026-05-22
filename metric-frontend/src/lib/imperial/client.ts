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
  FundingRateRow,
  MarkPriceRow,
  OrderRequest,
  OrderResponse,
  PositionList,
  RegisterPhoenixResponse,
  RouteResponse,
  SyncSweepResponse,
  UpdateRequest,
  VenueTag,
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
