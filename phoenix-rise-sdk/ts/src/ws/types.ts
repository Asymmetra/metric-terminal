import type { AuthSession } from "@/auth/session";
import type { AuthSessionManager } from "@/auth/manager";
import type { RiseSessionControl, RiseWsAuthMode } from "@/auth/types";
import type { WsServerErrorMessage } from "./plugins/default";

export interface WsClientOpts {
  url: string;
  protocol?: string | string[] | undefined;
  backoff?: { baseMs: number; maxMs: number };
  sessionManager?: AuthSessionManager;
  refreshFn?: (refreshToken: string) => Promise<AuthSession>;
  sessionControl?: RiseSessionControl;
  authMode?: RiseWsAuthMode;
  onServerError?: WsServerErrorListener;
}

export type WsClientConfig = Omit<WsClientOpts, "backoff"> & {
  backoff: Required<NonNullable<WsClientOpts["backoff"]>>;
};

export interface SubscriptionMessage {
  type: "subscribe" | "unsubscribe";
  subscription: Record<string, unknown>;
}

export interface WsChannelRegistration {
  validate: (message: unknown) => boolean;
  getKey: (message: unknown) => string;
}

export interface WsClient {
  subscribe(
    key: string,
    subMsg: SubscriptionMessage,
    onMessage: (data: unknown) => void
  ): void;
  unsubscribe(key: string, unsubMsg: SubscriptionMessage): void;
  registerChannel(
    channel: string,
    registration: WsChannelRegistration
  ): () => void;
  close(): void;
  onServerError(listener: WsServerErrorListener): () => void;
}

export type Subscription = {
  onMsg: (data: unknown) => void;
  onResub?: () => void;
};

export type WsServerErrorListener = (message: WsServerErrorMessage) => void;
