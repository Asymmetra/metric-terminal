import {
  createAllMidsAdapter,
  createCandlesAdapter,
  createExchangeStatusAdapter,
  createFillsAdapter,
  createFundingRateAdapter,
  createL2BookAdapter,
  createMarkPriceAdapter,
  createMarketAdapter,
  createMarketStatsAdapter,
  createNotificationsAdapter,
  createOrderbookAdapter,
  createTraderStateAdapter,
} from "./adapters";
import type { PublicAdapterOptions } from "./adapters/options";
import type { RiseSessionControl, RiseWsAuthMode } from "@/auth/types";
import type { AuthSessionManager } from "@/auth/manager";
import type { AuthSession } from "@/auth/session";
import type {
  CustomSubscriptionDefinitions,
  CustomSubscriptionDefinition,
  RegisteredSubscriptionAdapter,
  RegisteredSubscriptionAdapters,
} from "./registerSubscriptions";
import type { WsClientOpts, WsServerErrorListener } from "./types";
import {
  registerSubscription as registerCustomSubscription,
  registerSubscriptions as registerCustomSubscriptions,
} from "./registerSubscriptions";
import { createWsClient } from "./WsClient";

export interface PhoenixWsClientConfig extends WsClientOpts {
  adapterOptions?: PublicAdapterOptions;
  strictMode?: boolean;
  sessionManager?: AuthSessionManager;
  refreshFn?: (refreshToken: string) => Promise<AuthSession>;
  sessionControl?: RiseSessionControl;
  authMode?: RiseWsAuthMode;
  onServerError?: WsServerErrorListener;
}

export interface PhoenixWsClient {
  wsClient: ReturnType<typeof createWsClient>;
  allMids: ReturnType<typeof createAllMidsAdapter>;
  candles: ReturnType<typeof createCandlesAdapter>;
  exchangeStatus: ReturnType<typeof createExchangeStatusAdapter>;
  fills: ReturnType<typeof createFillsAdapter>;
  fundingRate: ReturnType<typeof createFundingRateAdapter>;
  l2Book: ReturnType<typeof createL2BookAdapter>;
  markPrice: ReturnType<typeof createMarkPriceAdapter>;
  market: ReturnType<typeof createMarketAdapter>;
  marketStats: ReturnType<typeof createMarketStatsAdapter>;
  notifications: ReturnType<typeof createNotificationsAdapter>;
  orderbook: ReturnType<typeof createL2BookAdapter>;
  orderbookSnapshot: ReturnType<typeof createOrderbookAdapter>;
  registerSubscription: <TRaw, TUpdate, TParams extends unknown[]>(
    definition: CustomSubscriptionDefinition<TRaw, TUpdate, TParams>
  ) => RegisteredSubscriptionAdapter<TUpdate, TParams>;
  registerSubscriptions: <T extends CustomSubscriptionDefinitions>(
    definitions: T
  ) => RegisteredSubscriptionAdapters<T>;
  traderState: ReturnType<typeof createTraderStateAdapter>;
  onServerError: (listener: WsServerErrorListener) => () => void;
  close: () => void;
}

export const createPhoenixWsClient = (
  config: PhoenixWsClientConfig
): PhoenixWsClient => {
  const wsClient = createWsClient({
    url: config.url,
    protocol: config.protocol,
    backoff: config.backoff,
    sessionManager: config.sessionManager,
    refreshFn: config.refreshFn,
    sessionControl: config.sessionControl,
    authMode: config.authMode,
    onServerError: config.onServerError,
  });

  const allMids = createAllMidsAdapter(
    wsClient,
    config.adapterOptions?.allMids,
    config.strictMode
  );
  const candles = createCandlesAdapter(
    wsClient,
    config.adapterOptions?.candles,
    config.strictMode
  );
  const exchangeStatus = createExchangeStatusAdapter(
    wsClient,
    config.adapterOptions?.exchangeStatus,
    config.strictMode
  );
  const fills = createFillsAdapter(
    wsClient,
    config.adapterOptions?.fills,
    config.strictMode
  );
  const fundingRate = createFundingRateAdapter(
    wsClient,
    config.adapterOptions?.fundingRate,
    config.strictMode
  );
  const l2Book = createL2BookAdapter(
    wsClient,
    config.adapterOptions?.l2Book,
    config.strictMode
  );
  const markPrice = createMarkPriceAdapter(
    wsClient,
    config.adapterOptions?.markPrice,
    config.strictMode
  );
  const market = createMarketAdapter(
    wsClient,
    config.adapterOptions?.market,
    config.strictMode
  );
  const marketStats = createMarketStatsAdapter(
    wsClient,
    config.adapterOptions?.marketStats,
    config.strictMode
  );
  const notifications = createNotificationsAdapter(
    wsClient,
    config.adapterOptions?.notifications,
    config.strictMode
  );
  const orderbook = createL2BookAdapter(
    wsClient,
    config.adapterOptions?.orderbook,
    config.strictMode
  );
  const orderbookSnapshot = createOrderbookAdapter(
    wsClient,
    config.adapterOptions?.orderbookSnapshot,
    config.strictMode
  );
  const traderState = createTraderStateAdapter(
    wsClient,
    config.adapterOptions?.traderState,
    config.strictMode
  );

  return {
    wsClient,
    allMids,
    candles,
    exchangeStatus,
    fills,
    fundingRate,
    l2Book,
    markPrice,
    market,
    marketStats,
    notifications,
    orderbook,
    orderbookSnapshot,
    registerSubscription: <TRaw, TUpdate, TParams extends unknown[]>(
      definition: CustomSubscriptionDefinition<TRaw, TUpdate, TParams>
    ): RegisteredSubscriptionAdapter<TUpdate, TParams> =>
      registerCustomSubscription(wsClient, definition),
    registerSubscriptions: <T extends CustomSubscriptionDefinitions>(
      definitions: T
    ): RegisteredSubscriptionAdapters<T> =>
      registerCustomSubscriptions(wsClient, definitions),
    traderState,
    onServerError: (listener: WsServerErrorListener) =>
      wsClient.onServerError(listener),
    close: () => wsClient.close(),
  };
};
