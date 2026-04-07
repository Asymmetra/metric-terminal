import { handleError, initializeErrorSystem } from "./errorHandling";
import { createConnectionError } from "./errorHandling/errors";
import { createMessageHandler } from "./messageHandler";
import { createDefaultPlugins, createPluginRegistry } from "./plugins";
import { debugWs } from "./debug";
import { AuthWsLifecycleController } from "./authLifecycleMachine";
import type {
  Subscription,
  SubscriptionMessage,
  WsChannelRegistration,
  WsClient,
  WsClientConfig,
  WsClientOpts,
  WsServerErrorListener,
} from "./types";

const isExternalSessionControl = (
  value: WsClientOpts["sessionControl"]
): boolean => value === "external";

export const createWsClient = (opts: WsClientOpts): WsClient => {
  let ws: WebSocket | undefined;
  let connectInFlight: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let deferredScheduleImmediate = false;

  const authMode =
    opts.authMode ?? (opts.sessionManager ? "auto" : "anonymous");
  const clientControlsSession = isExternalSessionControl(opts.sessionControl);

  const config: WsClientConfig = {
    ...opts,
    backoff: opts.backoff ?? { baseMs: 500, maxMs: 10_000 },
  };
  const lifecycle = new AuthWsLifecycleController(config.backoff, authMode);

  debugWs("ws client initialized", {
    url: config.url,
    authMode,
    hasSessionManager: Boolean(opts.sessionManager),
  });

  initializeErrorSystem();

  const subscriptionRegistry = new Map<string, Subscription>();
  const serverErrorListeners = new Set<WsServerErrorListener>();
  if (opts.onServerError) {
    serverErrorListeners.add(opts.onServerError);
  }

  const emitServerError = (message: {
    channel: "error";
    error: string;
    code: number;
  }) => {
    for (const listener of serverErrorListeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not disrupt websocket processing.
      }
    }
  };

  const pluginRegistry = createPluginRegistry(
    createDefaultPlugins({
      onServerErrorFrame: emitServerError,
    })
  );
  const customChannelRegistry = new Map<string, WsChannelRegistration>();
  const handleMessage = createMessageHandler(pluginRegistry);

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const applyEffect = (
    effect:
      | { type: "close_socket" }
      | {
          type: "schedule_connect";
          waitMs: number;
          mode: "backoff" | "immediate";
        }
      | { type: "handle_auth_close_policy" }
  ) => {
    switch (effect.type) {
      case "close_socket": {
        ws?.close();
        return;
      }
      case "schedule_connect": {
        if (lifecycle.isClosing) return;
        if (connectInFlight) {
          deferredScheduleImmediate ||= effect.mode === "immediate";
          return;
        }
        clearReconnectTimer();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connect();
        }, effect.waitMs);
        return;
      }
      case "handle_auth_close_policy": {
        void handleAuthClosePolicy();
        return;
      }
    }
  };

  const flushEffects = () => {
    const effects = lifecycle.drainEffects();
    for (const effect of effects) {
      applyEffect(effect);
    }
  };

  const requestReconnect = (mode: "backoff" | "immediate" = "backoff") => {
    if (lifecycle.isClosing) return;
    lifecycle.send({ type: "REQUEST_RECONNECT", mode, hasSocket: Boolean(ws) });
    flushEffects();
  };

  const scheduleReconnect = () => requestReconnect("immediate");

  const awaitExternalSessionChange = () => {
    clearReconnectTimer();
    lifecycle.send({ type: "AWAIT_AUTH" });
  };

  const wantsAuthenticatedConnection = () => {
    if (authMode === "authenticated") return true;
    if (authMode === "anonymous") return false;
    return lifecycle.knownAuthToken !== null;
  };

  const sendSerialized = (payload: string) => {
    if (!ws || !lifecycle.isConnected) return;
    if (
      lifecycle.connectionAuth === "anonymous" &&
      wantsAuthenticatedConnection()
    ) {
      requestReconnect("immediate");
      return;
    }
    ws.send(payload);
  };

  const send = (obj: unknown) => {
    sendSerialized(JSON.stringify(obj));
  };

  const onClose = async (evt?: CloseEvent) => {
    lifecycle.send({
      type: "SOCKET_CLOSE",
      code: evt?.code,
      reason: evt?.reason,
    });
    ws = undefined;
    flushEffects();
  };

  const handleAuthClosePolicy = async (): Promise<void> => {
    if (lifecycle.isClosing) return;
    const sessionManager = opts.sessionManager;
    if (!sessionManager) return;

    if (clientControlsSession) {
      awaitExternalSessionChange();
      return;
    }

    if (!opts.refreshFn) return;

    try {
      await sessionManager.refreshWith(opts.refreshFn);
      requestReconnect("immediate");
    } catch {
      await sessionManager.clearSession();
    }
  };

  const onError = async () => {
    lifecycle.send({
      type: "SOCKET_ERROR",
      message: "WebSocket connection error",
    });
    const activeSocket = ws;
    ws = undefined;
    try {
      activeSocket?.close();
    } catch {
      // Best-effort close.
    }
    flushEffects();

    const error = createConnectionError("WebSocket connection error", {
      operation: "connection",
    });
    await handleError(error);
  };

  const mergeProtocolToken = (
    protocol: string | string[] | undefined,
    token: string | null
  ): string | string[] | undefined => {
    if (!token) return protocol;
    if (!protocol) return ["phoenix-jwt", token];

    if (Array.isArray(protocol)) {
      const next = [...protocol];
      let injected = false;
      for (let i = 0; i < next.length; i += 1) {
        const current = next[i];
        const lower = current.toLowerCase();
        if (lower === "phoenix-jwt") {
          if (i + 1 < next.length) {
            next[i + 1] = token;
          } else {
            next.splice(i + 1, 0, token);
          }
          injected = true;
          break;
        }
        if (lower.startsWith("phoenix-jwt=")) {
          next[i] = `phoenix-jwt=${token}`;
          injected = true;
          break;
        }
        if (lower.startsWith("phoenix-jwt:")) {
          next[i] = `phoenix-jwt:${token}`;
          injected = true;
          break;
        }
      }
      if (!injected) {
        next.push("phoenix-jwt", token);
      }
      return next;
    }

    const trimmed = protocol.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "phoenix-jwt") return ["phoenix-jwt", token];
    if (lower.startsWith("phoenix-jwt=")) return `phoenix-jwt=${token}`;
    if (lower.startsWith("phoenix-jwt:")) return `phoenix-jwt:${token}`;
    if (trimmed.includes(",")) {
      const parts = trimmed
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      return mergeProtocolToken(parts, token);
    }
    return [protocol, "phoenix-jwt", token];
  };

  const extractProtocolToken = (
    protocol?: string | string[]
  ): string | null => {
    if (!protocol) return null;
    const protocols = Array.isArray(protocol)
      ? protocol
      : protocol.split(",").map((part) => part.trim());
    for (let i = 0; i < protocols.length; i += 1) {
      const current = protocols[i];
      const lower = current.toLowerCase();
      if (lower === "phoenix-jwt") {
        const next = protocols[i + 1];
        if (next) return next;
      }
      if (lower.startsWith("phoenix-jwt=")) {
        return current.slice("phoenix-jwt=".length);
      }
      if (lower.startsWith("phoenix-jwt:")) {
        return current.slice("phoenix-jwt:".length);
      }
    }
    return null;
  };

  const resolveProtocol = async () => {
    if (authMode === "anonymous") return config.protocol;
    const session = await opts.sessionManager?.getSession();
    if (!session) return config.protocol;
    return mergeProtocolToken(config.protocol, session.accessToken);
  };

  const handleAuthChange = (session: { accessToken: string } | null) => {
    lifecycle.send({
      type: "AUTH_SESSION_CHANGED",
      token: session?.accessToken ?? null,
      hasSocket: Boolean(ws),
    });
    flushEffects();
  };

  const sessionUnsub = opts.sessionManager?.onChange(handleAuthChange);

  const connect = async () => {
    if (lifecycle.isClosing || connectInFlight) return;
    clearReconnectTimer();

    connectInFlight = (async () => {
      try {
        const protocol = await resolveProtocol();
        const protocolToken = extractProtocolToken(protocol);
        lifecycle.send({ type: "AUTH_TOKEN_OBSERVED", token: protocolToken });

        if (authMode === "authenticated" && !protocolToken) {
          lifecycle.send({ type: "AWAIT_AUTH" });
          return;
        }

        const pendingAuth =
          protocolToken !== null ? "authenticated" : "anonymous";
        lifecycle.send({ type: "CONNECT_START", pendingAuth });

        const websocket = new WebSocket(config.url, protocol);
        ws = websocket;

        websocket.onopen = () => {
          lifecycle.send({ type: "SOCKET_OPEN" });
          for (const sub of subscriptionRegistry.values()) {
            sub.onResub?.();
          }
        };

        websocket.onmessage = (evt) => {
          if (typeof evt.data !== "string") return;
          void handleMessage(evt.data, subscriptionRegistry);
        };
        websocket.onclose = (evt) => void onClose(evt);
        websocket.onerror = () => {
          void onError();
        };
      } catch (error) {
        const wsError = createConnectionError(
          "WebSocket connection failed",
          {
            operation: "connection",
            attempt: lifecycle.reconnectAttempt + 1,
            maxAttempts: 10,
          },
          error instanceof Error ? error : new Error(String(error))
        );
        await handleError(wsError);
        requestReconnect("backoff");
      }
    })().finally(() => {
      connectInFlight = null;
      flushEffects();
      if (!lifecycle.isClosing && deferredScheduleImmediate) {
        deferredScheduleImmediate = false;
        requestReconnect("immediate");
      }
    });
  };

  void connect();

  return {
    subscribe(
      key: string,
      subMsg: SubscriptionMessage,
      onMessage: (data: unknown) => void
    ) {
      subscriptionRegistry.set(key, {
        onMsg: onMessage,
        onResub: () => send(subMsg),
      });
      if (lifecycle.isConnected) {
        if (
          lifecycle.connectionAuth === "anonymous" &&
          wantsAuthenticatedConnection()
        ) {
          scheduleReconnect();
          return;
        }
        send(subMsg);
      }
    },

    unsubscribe(key: string, unsubMsg: SubscriptionMessage) {
      subscriptionRegistry.delete(key);
      if (lifecycle.isConnected) {
        if (
          lifecycle.connectionAuth === "anonymous" &&
          wantsAuthenticatedConnection()
        ) {
          scheduleReconnect();
          return;
        }
        send(unsubMsg);
      }
    },

    registerChannel(channel: string, registration: WsChannelRegistration) {
      const existingCustom = customChannelRegistry.get(channel);
      if (existingCustom) {
        if (
          existingCustom.validate === registration.validate &&
          existingCustom.getKey === registration.getKey
        ) {
          return () => {};
        }
        throw new Error(`WebSocket channel already registered: ${channel}`);
      }

      if (pluginRegistry.getHandler(channel)) {
        throw new Error(`WebSocket channel already registered: ${channel}`);
      }

      customChannelRegistry.set(channel, registration);
      pluginRegistry.register(() => ({
        channel,
        validate: registration.validate,
        getKey: registration.getKey,
        handle: async (
          message: unknown,
          registry: Map<string, Subscription>
        ): Promise<void> => {
          const sub = registry.get(registration.getKey(message));
          sub?.onMsg(message);
        },
      }));

      return () => {
        customChannelRegistry.delete(channel);
        pluginRegistry.unregister(channel);
      };
    },

    close() {
      lifecycle.send({ type: "CLOSE_CLIENT" });
      clearReconnectTimer();
      sessionUnsub?.();
      ws?.close();
      subscriptionRegistry.clear();
      customChannelRegistry.clear();
      lifecycle.stop();
    },

    onServerError(listener: WsServerErrorListener) {
      serverErrorListeners.add(listener);
      return () => {
        serverErrorListeners.delete(listener);
      };
    },
  };
};
