import { PhoenixAuthError } from "@/errors";
import { AuthBackoffManager } from "./backoff";
import { AuthSessionManager } from "./manager";
import {
  fromSnapshot,
  isAccessExpired,
  isAccessExpiringWithin,
  isRefreshExpired,
  type AuthSession,
  type AuthSessionSnapshot,
} from "./session";
import { MemoryAuthSessionStorage } from "./storage";
import { PhoenixAuthClient } from "./client";
import type { RiseAuthBootstrapReason, RiseAuthConfig } from "./types";

const ACCESS_REFRESH_WINDOW_MS = 60_000;

const isSnapshot = (
  session: AuthSession | AuthSessionSnapshot
): session is AuthSessionSnapshot => "popKey" in session;

const isTerminalRefreshError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "invalid_refresh_token" ||
    code === "refresh_expired" ||
    code === "session_missing"
  );
};

export class RiseAuthRuntime {
  private readonly config: RiseAuthConfig | undefined;
  private readonly backoff = new AuthBackoffManager();
  private readonly sessionManager?: AuthSessionManager;
  private readonly authClient?: PhoenixAuthClient;

  constructor(baseUrl: string, timeout: number, config?: RiseAuthConfig) {
    this.config = config;
    if (!config) return;

    const sessionManager =
      config.sessionManager ??
      new AuthSessionManager(config.storage ?? new MemoryAuthSessionStorage());
    this.sessionManager = sessionManager;
    this.authClient = new PhoenixAuthClient({
      baseUrl,
      timeout,
      sessionManager,
      sessionControl: config.sessionControl,
    });

    if (config.initialSession) {
      const normalized = isSnapshot(config.initialSession)
        ? fromSnapshot(config.initialSession)
        : config.initialSession;
      void sessionManager.updateSession(normalized);
    }

    if (config.mode === "auth_enabled" && config.bootstrapper) {
      void this.bootstrap("missing_session").catch(() => {
        // Best effort eager auth; requests will retry lazily later.
      });
    }
  }

  isEnabled(): boolean {
    return this.config !== undefined;
  }

  getSessionManager(): AuthSessionManager | undefined {
    return this.sessionManager;
  }

  getAuthClient(): PhoenixAuthClient | undefined {
    return this.authClient;
  }

  async exportSnapshot(): Promise<AuthSessionSnapshot | null> {
    return this.sessionManager?.exportSnapshot() ?? null;
  }

  private nextRetryAt(kind: "bootstrap" | "refresh"): number | null {
    return this.backoff.get(kind).nextRetryAt;
  }

  private requiredAuthError(message: string): never {
    const retryAt = Math.max(
      this.nextRetryAt("bootstrap") ?? 0,
      this.nextRetryAt("refresh") ?? 0
    );
    throw new PhoenixAuthError(message, "auth_required", {
      retryAt: retryAt || null,
    });
  }

  async maybeGetSession(
    authPolicy: "optional" | "required"
  ): Promise<AuthSession | null> {
    if (!this.config || !this.sessionManager) {
      if (authPolicy === "required") {
        this.requiredAuthError(
          "Authenticated request requires auth to be enabled"
        );
      }
      return null;
    }

    let session = await this.sessionManager.getSession();

    if (session && isRefreshExpired(session)) {
      await this.sessionManager.clearSession();
      session = null;
    }

    if (session && isAccessExpiringWithin(session, ACCESS_REFRESH_WINDOW_MS)) {
      const refreshed = await this.tryRefresh();
      if (refreshed) session = refreshed;
    }

    if (session && !isAccessExpired(session)) {
      return session;
    }

    const bootstrapped = await this.bootstrap(
      session ? "expired_session" : "missing_session"
    );
    if (bootstrapped) return bootstrapped;

    if (authPolicy === "required") {
      this.requiredAuthError(
        "Authenticated request requires an active session"
      );
    }

    return null;
  }

  async recoverAfterUnauthorized(
    authPolicy: "optional" | "required"
  ): Promise<AuthSession | null> {
    const refreshed = await this.tryRefresh();
    if (refreshed) return refreshed;

    const bootstrapped = await this.bootstrap("unauthorized");
    if (bootstrapped) return bootstrapped;

    if (authPolicy === "required") {
      this.requiredAuthError(
        "Authenticated request failed and could not refresh the session"
      );
    }

    return null;
  }

  private async tryRefresh(): Promise<AuthSession | null> {
    if (!this.sessionManager || !this.authClient) return null;
    if (this.backoff.isBlocked("refresh")) return null;

    const session = await this.sessionManager.getSession();
    if (!session || isRefreshExpired(session)) return null;

    try {
      const next = await this.sessionManager.refreshWith((refreshToken) =>
        this.authClient!.refresh(refreshToken)
      );
      this.backoff.reset("refresh");
      return next;
    } catch (error) {
      const retryAfterSeconds =
        error instanceof PhoenixAuthError && error.retryAfterMs !== undefined
          ? Math.ceil(error.retryAfterMs / 1000)
          : undefined;
      const code =
        error instanceof PhoenixAuthError ? error.code : "refresh_failed";
      this.backoff.markFailure("refresh", {
        retryAfterSeconds,
        errorCode: code,
      });
      if (isTerminalRefreshError(error)) {
        await this.sessionManager.clearSession();
      }
      return null;
    }
  }

  private async bootstrap(
    reason: RiseAuthBootstrapReason
  ): Promise<AuthSession | null> {
    if (!this.config?.bootstrapper || !this.sessionManager) return null;
    if (this.backoff.isBlocked("bootstrap")) return null;

    try {
      const result = await this.config.bootstrapper.bootstrap(reason);
      if (!result) {
        this.backoff.markFailure("bootstrap", {
          errorCode: "bootstrap_returned_null",
        });
        return null;
      }

      const session = isSnapshot(result) ? fromSnapshot(result) : result;
      await this.sessionManager.updateSession(session);
      this.backoff.reset("bootstrap");
      return session;
    } catch (error) {
      const retryAfterSeconds =
        error instanceof PhoenixAuthError && error.retryAfterMs !== undefined
          ? Math.ceil(error.retryAfterMs / 1000)
          : undefined;
      const code =
        error instanceof PhoenixAuthError ? error.code : "bootstrap_failed";
      this.backoff.markFailure("bootstrap", {
        retryAfterSeconds,
        errorCode: code,
      });
      return null;
    }
  }
}
