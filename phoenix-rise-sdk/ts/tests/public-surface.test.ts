import * as rise from "@/index";
import { describe, expect, it } from "vitest";

describe("rise public surface", () => {
  it("exports the public parity clients from the package api namespace", () => {
    expect(rise.api).toHaveProperty("V1CandlesClient");
    expect(rise.api).toHaveProperty("V1CollateralClient");
    expect(rise.api).toHaveProperty("V1ExchangeClient");
    expect(rise.api).toHaveProperty("V1FundingClient");
    expect(rise.api).toHaveProperty("V1InviteClient");
    expect(rise.api).toHaveProperty("V1MarketsClient");
    expect(rise.api).toHaveProperty("V1NotificationsClient");
    expect(rise.api).toHaveProperty("V1OrdersClient");
    expect(rise.api).toHaveProperty("V1TradersClient");
    expect(rise.api).toHaveProperty("V1TradesClient");
  });

  it("exposes the public parity accessors on PhoenixHttpClient", () => {
    const client = new rise.PhoenixHttpClient({
      baseUrl: "https://perp-api.phoenix.trade",
    });

    expect("candles" in client).toBe(true);
    expect("collateral" in client).toBe(true);
    expect("exchange" in client).toBe(true);
    expect("funding" in client).toBe(true);
    expect("invite" in client).toBe(true);
    expect("markets" in client).toBe(true);
    expect("notifications" in client).toBe(true);
    expect("orders" in client).toBe(true);
    expect("traders" in client).toBe(true);
    expect("trades" in client).toBe(true);
    expect("auth" in client).toBe(true);
    expect("sessionManager" in client).toBe(true);
    expect("exportAuthSnapshot" in client).toBe(true);
    expect("publicApi" in client).toBe(false);
    expect("getMarkets" in client).toBe(false);
    expect("getTrader" in client).toBe(false);
  });

  it("keeps the exported resource methods on the public/data parity surface", () => {
    const client = new rise.PhoenixHttpClient({
      baseUrl: "https://perp-api.phoenix.trade",
    });

    expect("getCandles" in client.candles()).toBe(true);

    expect("getTraderCollateralHistory" in client.collateral()).toBe(true);
    expect("getUserCollateralHistory" in client.collateral()).toBe(true);
    expect("getAllUserCollateralHistory" in client.collateral()).toBe(true);

    expect("getMarkets" in client.markets()).toBe(true);
    expect("getMarket" in client.markets()).toBe(true);
    expect("getMarketStatsHistory" in client.markets()).toBe(true);
    expect("getPriceHistory" in client.markets()).toBe(false);

    expect("getTraderFundingHistory" in client.funding()).toBe(true);
    expect("getUserFundingHourly" in client.funding()).toBe(true);

    expect("activateInvite" in client.invite()).toBe(true);

    expect("getNotificationsByTrader" in client.notifications()).toBe(true);
    expect("ackUpToTimestamp" in client.notifications()).toBe(true);
    expect("ackNotifications" in client.notifications()).toBe(true);

    expect("getTraderOrderHistory" in client.orders()).toBe(true);
    expect("placeIsolatedLimitOrder" in client.orders()).toBe(true);
    expect("placeIsolatedMarketOrder" in client.orders()).toBe(true);
    expect("getTraderOrderHistoryV2" in client.orders()).toBe(true);
    expect("getOrderDetails" in client.orders()).toBe(false);

    expect("getTrader" in client.traders()).toBe(true);
    expect("getTraderState" in client.traders()).toBe(true);
    expect("getTraderPnl" in client.traders()).toBe(true);
    expect("getTraderCapabilities" in client.traders()).toBe(true);
    expect("getActiveTraders" in client.traders()).toBe(false);
    expect("getTraderPortfolioValues" in client.traders()).toBe(true);
    expect("getTraderPnlValues" in client.traders()).toBe(true);
    expect("getTraderMarketPnl" in client.traders()).toBe(true);
    expect("getTraderPendingEscrowRequests" in client.traders()).toBe(false);

    expect("getTraderTradesHistory" in client.trades()).toBe(true);
    expect("getMarketFills" in client.trades()).toBe(true);
    expect("getTraderTradeHistoryV2" in client.trades()).toBe(true);
  });

  it("does not expose path catalog helpers from the root package", () => {
    expect(rise).not.toHaveProperty("PUBLIC_API_PATHS");
    expect(rise).not.toHaveProperty("PUBLIC_API_PATH_SET");
    expect(rise).not.toHaveProperty("PUBLIC_V1_DATA_PATHS");
    expect(rise).not.toHaveProperty("PUBLIC_V1_DATA_PATH_SET");
    expect(rise).not.toHaveProperty("resolvePublicApiPath");
  });

  it("exports the migrated instruction builders from the root package", () => {
    expect(rise).toHaveProperty("buildCancelUpToIx");
    expect(rise).toHaveProperty("buildPlaceMultiLimitOrderIx");
    expect(rise).toHaveProperty("buildSyncTraderCapabilities");
    expect(rise).toHaveProperty("buildSyncTraderCapabilitiesIx");
    expect(rise).toHaveProperty("buildUpdateSplineParametersIx");
    expect(rise).toHaveProperty("buildUpdateSplinePriceIx");
    expect(rise).toHaveProperty("buildUpdateTraderStateIx");
  });

  it("exports the public websocket subscription factories from the root package", () => {
    expect(rise).toHaveProperty("auth");
    expect(rise).toHaveProperty("createPhoenixClient");
    expect(rise).toHaveProperty("createAllMidsAdapter");
    expect(rise).toHaveProperty("createCandlesAdapter");
    expect(rise).toHaveProperty("createExchangeStatusAdapter");
    expect(rise).toHaveProperty("createFillsAdapter");
    expect(rise).toHaveProperty("createFundingRateAdapter");
    expect(rise).toHaveProperty("createL2BookAdapter");
    expect(rise).toHaveProperty("createMarkPriceAdapter");
    expect(rise).toHaveProperty("createMarketAdapter");
    expect(rise).toHaveProperty("createMarketStatsAdapter");
    expect(rise).toHaveProperty("createNotificationsAdapter");
    expect(rise).toHaveProperty("createOrderbookAdapter");
    expect(rise).toHaveProperty("createTraderStateAdapter");
    expect(rise).toHaveProperty("registerSubscription");
    expect(rise).toHaveProperty("registerSubscriptions");
  });
});
