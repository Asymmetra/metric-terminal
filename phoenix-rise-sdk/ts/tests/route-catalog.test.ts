import { describe, expect, it } from "vitest";

import { RISE_ROUTE_CATALOG } from "@/generated/routeCatalog";

const BLACKLISTED_OPERATION_IDS = new Set([
  "liveness_check",
  "readiness_check",
  "startup_check",
  "v1.sponsorship.get_pubkeys",
  "v1.sponsorship.get_fee_payer",
  "v1.sponsorship.sponsor_transaction",
]);

describe("rise route catalog", () => {
  it("includes the supported public and user-scoped rise routes", () => {
    expect(RISE_ROUTE_CATALOG).toHaveProperty("PublicExchangeGet");
    expect(RISE_ROUTE_CATALOG).toHaveProperty("AuthLoginPrivy");
    expect(RISE_ROUTE_CATALOG).toHaveProperty("NotificationsGetNotifications");
    expect(RISE_ROUTE_CATALOG).toHaveProperty(
      "PortfolioGetTraderPortfolioValues"
    );
    expect(RISE_ROUTE_CATALOG).toHaveProperty("V1GetTraderOrderHistoryV2");
    expect(RISE_ROUTE_CATALOG).toHaveProperty("WsWebsocketEntry");
  });

  it("excludes admin, status-probe, and sponsorship metadata", () => {
    expect(RISE_ROUTE_CATALOG).not.toHaveProperty("LivenessCheck");
    expect(RISE_ROUTE_CATALOG).not.toHaveProperty("ReadinessCheck");
    expect(RISE_ROUTE_CATALOG).not.toHaveProperty("StartupCheck");
    expect(RISE_ROUTE_CATALOG).not.toHaveProperty("SponsorshipGetPubkeys");
    expect(RISE_ROUTE_CATALOG).not.toHaveProperty("AdminListReferralCodes");
    expect(RISE_ROUTE_CATALOG).not.toHaveProperty("AuthLoginAdmin");
  });

  it("contains no admin-auth or blacklisted operations", () => {
    const routes = Object.values(RISE_ROUTE_CATALOG);

    expect(routes.every((route) => route.auth !== "Admin")).toBe(true);
    expect(
      routes.every((route) => !BLACKLISTED_OPERATION_IDS.has(route.operationId))
    ).toBe(true);
  });
});
