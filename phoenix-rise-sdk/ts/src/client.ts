import type { HttpTransport, RequestOptions } from "./http/transport";
import { appendQueryParams } from "./http/transport";
import { V1CandlesClient } from "./api/candles/client";
import { V1CollateralClient } from "./api/collateral/client";
import { V1ExchangeClient } from "./api/exchange/client";
import { V1FundingClient } from "./api/funding/client";
import { V1InviteClient } from "./api/invite/client";
import { V1MarketsClient } from "./api/markets/client";
import { V1NotificationsClient } from "./api/notifications/client";
import { V1OrdersClient } from "./api/orders/client";
import { V1TradersClient } from "./api/traders/client";
import { V1TradesClient } from "./api/trades/client";
import { RiseAuthRuntime } from "./auth/runtime";
import type { AuthSessionManager } from "./auth/manager";
import type { PhoenixAuthClient } from "./auth/client";
import type { AuthSessionSnapshot } from "./auth/session";
import type { RiseAuthConfig } from "./auth/types";
import { getPhoenixClientHeader } from "./clientIdentity";
import { getRiseRouteMeta } from "./generated/routeCatalog";
import { createPhoenixWsClient } from "./ws/PhoenixWsClient";
import { toWebSocketUrl } from "./ws/url";
import type {
  PhoenixWsClient,
  PhoenixWsClientConfig,
} from "./ws/PhoenixWsClient";

const DEFAULT_TIMEOUT = 30_000;
const AUTH_RETRYABLE_CODES = new Set([
  "missing_access_token",
  "invalid_access_token",
  "access_token_expired",
  "access_jti_mismatch",
  "session_missing",
]);

const parseRetryAfterSeconds = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const parsedSeconds = Number(trimmed);
  if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
    return Math.ceil(parsedSeconds);
  }
  const retryDate = Date.parse(trimmed);
  if (Number.isNaN(retryDate)) return undefined;
  const deltaMs = retryDate - Date.now();
  if (deltaMs <= 0) return 0;
  return Math.ceil(deltaMs / 1000);
};

const parseErrorPayload = async (
  response: Response
): Promise<{
  code?: string;
  message?: string;
  body?: Record<string, unknown>;
}> => {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      code: typeof parsed.error === "string" ? parsed.error : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      body: parsed,
    };
  } catch {
    return {};
  }
};

export interface PhoenixHttpClientConfig {
  /** Base URL of the Phoenix API server */
  baseUrl: string;
  /** Optional API key sent as x-api-key header */
  apiKey?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Optional additional headers resolved per request. */
  extraHeaders?:
    | (() =>
        | Promise<Record<string, string> | undefined>
        | Record<string, string>
        | undefined)
    | undefined;
  /** Optional auth capability for attaching/refreshing end-user sessions. */
  auth?: RiseAuthConfig;
}

/**
 * HTTP client for the public Phoenix API surface exposed by `rise`.
 *
 * @example
 * ```ts
 * const client = new PhoenixHttpClient({ baseUrl: "https://api.phoenix.trade" });
 *
 * const exchange = await client.exchange().getExchange();
 * const trader = await client.traders().getTrader(traderPubkey);
 * ```
 */
export class PhoenixHttpClient implements HttpTransport {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly extraHeaders?: PhoenixHttpClientConfig["extraHeaders"];
  private readonly authRuntime?: RiseAuthRuntime;
  private readonly candlesClient: V1CandlesClient;
  private readonly collateralClient: V1CollateralClient;
  private readonly exchangeClient: V1ExchangeClient;
  private readonly fundingClient: V1FundingClient;
  private readonly inviteClient: V1InviteClient;
  private readonly marketsClient: V1MarketsClient;
  private readonly notificationsClient: V1NotificationsClient;
  private readonly ordersClient: V1OrdersClient;
  private readonly tradersClient: V1TradersClient;
  private readonly tradesClient: V1TradesClient;

  constructor(config: PhoenixHttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.extraHeaders = config.extraHeaders;
    this.authRuntime = config.auth
      ? new RiseAuthRuntime(this.baseUrl, this.timeout, config.auth)
      : undefined;
    this.candlesClient = new V1CandlesClient(this);
    this.collateralClient = new V1CollateralClient(this);
    this.exchangeClient = new V1ExchangeClient(this);
    this.fundingClient = new V1FundingClient(this);
    this.inviteClient = new V1InviteClient(this);
    this.marketsClient = new V1MarketsClient(this);
    this.notificationsClient = new V1NotificationsClient(this);
    this.ordersClient = new V1OrdersClient(this);
    this.tradersClient = new V1TradersClient(this);
    this.tradesClient = new V1TradesClient(this);
  }

  private resolveAuthPolicy(
    options?: RequestOptions
  ): "disabled" | "optional" | "required" {
    if (options?.auth) {
      return options.auth;
    }
    if (!options?.routeId) {
      return this.authRuntime ? "optional" : "disabled";
    }
    const authScope = getRiseRouteMeta(options.routeId).auth;
    if (authScope === "Public") {
      return this.authRuntime ? "optional" : "disabled";
    }
    return "required";
  }

  private async performFetch(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    controller: AbortController
  ): Promise<Response> {
    try {
      return await globalThis.fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown network error";
      throw new Error(
        `Failed to connect to the Phoenix HTTP API (${method} ${url.toString()}): ${message}`,
        { cause: error }
      );
    }
  }

  private async resolveExtraHeaders(): Promise<Record<string, string>> {
    if (!this.extraHeaders) return {};
    const headers = await this.extraHeaders();
    return headers ?? {};
  }

  async fetch(
    method: string,
    endpoint: string,
    options?: RequestOptions,
    body?: unknown
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (options?.params) appendQueryParams(url, options.params);

    const authPolicy = this.resolveAuthPolicy(options);
    const session = await this.authRuntime?.maybeGetSession(
      authPolicy === "disabled" ? "optional" : authPolicy
    );
    const requestBody = body !== undefined ? JSON.stringify(body) : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const baseHeaders: Record<string, string> = {
        ...getPhoenixClientHeader(),
        ...(await this.resolveExtraHeaders()),
        ...options?.headers,
      };
      if (this.apiKey) baseHeaders["x-api-key"] = this.apiKey;
      if (requestBody !== undefined) {
        baseHeaders["content-type"] = "application/json";
      }

      const execute = async (authorization?: string): Promise<Response> => {
        const headers: Record<string, string> = {
          ...baseHeaders,
        };
        if (authorization) headers.Authorization = authorization;
        return this.performFetch(url, method, headers, requestBody, controller);
      };

      const authorizedResponse = await execute(
        session ? `Bearer ${session.accessToken}` : undefined
      );

      if (
        authorizedResponse.status === 429 &&
        (method === "GET" || method === "HEAD")
      ) {
        const retryAfterSeconds = parseRetryAfterSeconds(
          authorizedResponse.headers.get("retry-after")
        );
        const waitMs = Math.max(
          1_000,
          Math.min(30_000, (retryAfterSeconds ?? 1) * 1000)
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return execute(session ? `Bearer ${session.accessToken}` : undefined);
      }

      if (
        authPolicy !== "disabled" &&
        session &&
        (authorizedResponse.status === 401 ||
          authorizedResponse.status === 403 ||
          authorizedResponse.status === 4401 ||
          authorizedResponse.status === 4403)
      ) {
        const { code } = await parseErrorPayload(authorizedResponse.clone());
        if (code && AUTH_RETRYABLE_CODES.has(code)) {
          const recovered =
            await this.authRuntime?.recoverAfterUnauthorized(authPolicy);
          if (recovered) {
            return execute(`Bearer ${recovered.accessToken}`);
          }
          if (authPolicy === "optional") {
            return execute(undefined);
          }
        }
      }

      return authorizedResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  candles(): V1CandlesClient {
    return this.candlesClient;
  }

  collateral(): V1CollateralClient {
    return this.collateralClient;
  }

  exchange(): V1ExchangeClient {
    return this.exchangeClient;
  }

  funding(): V1FundingClient {
    return this.fundingClient;
  }

  invite(): V1InviteClient {
    return this.inviteClient;
  }

  markets(): V1MarketsClient {
    return this.marketsClient;
  }

  notifications(): V1NotificationsClient {
    return this.notificationsClient;
  }

  orders(): V1OrdersClient {
    return this.ordersClient;
  }

  traders(): V1TradersClient {
    return this.tradersClient;
  }

  trades(): V1TradesClient {
    return this.tradesClient;
  }

  auth(): PhoenixAuthClient | undefined {
    return this.authRuntime?.getAuthClient();
  }

  sessionManager(): AuthSessionManager | undefined {
    return this.authRuntime?.getSessionManager();
  }

  async exportAuthSnapshot(): Promise<AuthSessionSnapshot | null> {
    return this.authRuntime?.exportSnapshot() ?? null;
  }

  dispose(): void {
    this.authRuntime?.getSessionManager()?.dispose();
  }
}

export interface PhoenixClientConfig extends PhoenixHttpClientConfig {
  ws?: Omit<PhoenixWsClientConfig, "sessionManager" | "refreshFn" | "url"> & {
    url?: string;
  };
}

export interface PhoenixClient {
  api: PhoenixHttpClient;
  auth?: PhoenixAuthClient;
  sessionManager?: AuthSessionManager;
  streams?: PhoenixWsClient;
  dispose(): void;
}

export const createPhoenixClient = (
  config: PhoenixClientConfig
): PhoenixClient => {
  const api = new PhoenixHttpClient(config);
  const auth = api.auth();
  const sessionManager = api.sessionManager();
  const streams = config.ws
    ? createPhoenixWsClient({
        ...config.ws,
        url: config.ws.url ?? toWebSocketUrl(config.baseUrl),
        sessionManager,
        refreshFn: auth
          ? (refreshToken: string) => auth.refresh(refreshToken)
          : undefined,
        authMode: config.ws.authMode ?? config.auth?.wsAuthMode,
      })
    : undefined;
  return {
    api: api,
    auth: auth,
    sessionManager: sessionManager,
    streams: streams,
    dispose: () => {
      streams?.close();
      api.dispose();
    },
  };
};
