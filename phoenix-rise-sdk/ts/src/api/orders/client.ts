import type { HttpTransport } from "@/http/transport";
import { get, post } from "@/http/transport";
import type { ParamValue } from "@/http/transport";
import type { InstructionsWithAccountsAndData } from "@/primitives/_utilityTypes";
import { AccountRole, address } from "@solana/kit";
import type {
  ApiInstructionResponse,
  OrderHistoryRequest,
  OrderHistoryResponse,
  OrderHistoryV2Request,
  OrderHistoryV2Response,
  PlaceIsolatedLimitOrderRequest,
  PlaceIsolatedMarketOrderRequest,
} from "./types";
import {
  ApiInstructionResponseSchema,
  OrderHistoryResponseSchema,
  OrderHistoryV2ResponseSchema,
  PlaceIsolatedLimitOrderRequestSchema,
  PlaceIsolatedMarketOrderRequestSchema,
} from "./types";

const buildOrderHistoryQuery = (
  request?: OrderHistoryRequest
): Record<string, ParamValue> | undefined => {
  if (!request) return undefined;

  const params: Record<string, ParamValue> = {};

  if (request.traderPdaIndex !== undefined)
    params.traderPdaIndex = request.traderPdaIndex;
  if (request.marketSymbol) params.marketSymbol = request.marketSymbol;
  if (request.limit !== undefined) params.limit = request.limit;
  if (request.cursor) params.cursor = request.cursor;
  if (request.privyId) params.privyId = request.privyId;
  if (request.orderStatus) params.orderStatus = request.orderStatus;

  return Object.keys(params).length > 0 ? params : undefined;
};

const buildOrderHistoryV2Query = (
  request?: OrderHistoryV2Request
): Record<string, ParamValue> | undefined => {
  if (!request) return undefined;

  const params: Record<string, ParamValue> = {};

  if (request.marketSymbol) params.market_symbol = request.marketSymbol;
  if (request.limit !== undefined) params.limit = request.limit;
  if (request.cursor) params.cursor = request.cursor;
  if (request.startTime) params.start_time = request.startTime.toISOString();
  if (request.endTime) params.end_time = request.endTime.toISOString();

  return Object.keys(params).length > 0 ? params : undefined;
};

const toInstruction = (
  apiInstruction: ApiInstructionResponse
): InstructionsWithAccountsAndData => ({
  programAddress: address(apiInstruction.programId),
  accounts: apiInstruction.keys.map((account) => ({
    address: address(account.pubkey),
    role: account.isSigner
      ? account.isWritable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : account.isWritable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY,
  })),
  data: Uint8Array.from(apiInstruction.data),
});

export class V1OrdersClient {
  constructor(private readonly http: HttpTransport) {}

  async getTraderOrderHistory(
    authority: string,
    request?: OrderHistoryRequest
  ): Promise<OrderHistoryResponse> {
    return get(
      this.http,
      `/trader/${encodeURIComponent(authority)}/order-history`,
      OrderHistoryResponseSchema,
      { params: buildOrderHistoryQuery(request) }
    );
  }

  async getTraderOrderHistoryV2(
    traderPubkey: string,
    request?: OrderHistoryV2Request
  ): Promise<OrderHistoryV2Response> {
    return get(
      this.http,
      `/v1/traders/${encodeURIComponent(traderPubkey)}/orders_v2`,
      OrderHistoryV2ResponseSchema,
      {
        params: buildOrderHistoryV2Query(request),
        routeId: "V1GetTraderOrderHistoryV2",
      }
    );
  }

  async placeIsolatedLimitOrder(
    request: PlaceIsolatedLimitOrderRequest
  ): Promise<InstructionsWithAccountsAndData[]> {
    return (
      await post(
        this.http,
        "/v1/ix/place-isolated-limit-order",
        ApiInstructionResponseSchema.array(),
        PlaceIsolatedLimitOrderRequestSchema.parse(request)
      )
    ).map(toInstruction);
  }

  async placeIsolatedMarketOrder(
    request: PlaceIsolatedMarketOrderRequest
  ): Promise<InstructionsWithAccountsAndData[]> {
    return (
      await post(
        this.http,
        "/v1/ix/place-isolated-market-order",
        ApiInstructionResponseSchema.array(),
        PlaceIsolatedMarketOrderRequestSchema.parse(request)
      )
    ).map(toInstruction);
  }
}
