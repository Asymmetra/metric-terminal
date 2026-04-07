import { createUpdateStream, normalizeTimestamp } from "@/ws/adapters/_utils";
import { handleError } from "@/ws/errorHandling/ErrorSystem";
import {
  createInvalidTimestampError,
  createWrongMarketError,
} from "@/ws/errorHandling/errors";
import type { WsClient } from "@/ws/types";
import { applyStrictModeRecursive } from "@/ws/zodStrictMode";
import type { L2BookPort } from "./ports";
import { L2BookMsgSchema, type L2BookMsg, type L2BookUpdate } from "./wire";

export type L2BookAdapter = L2BookPort;

export interface L2BookAdapterOptions {
  buffer?: number;
  timestampUnit?: "s" | "ms";
}

export const createL2BookAdapter = (
  ws: WsClient,
  opts?: L2BookAdapterOptions,
  strictMode?: boolean
): L2BookAdapter => {
  const { timestampUnit = "s" } = opts ?? {};
  const schema = strictMode
    ? applyStrictModeRecursive(L2BookMsgSchema)
    : L2BookMsgSchema;

  return createUpdateStream<L2BookMsg, L2BookUpdate, [market: string]>(
    ws,
    {
      channel: "l2Book",
      schema,
      buildKey: (market: string) => `l2Book:${market}`,
      buildSubParams: (market: string) => ({ coin: market }),
      processMessage: async (message, [market], context) => {
        if (message.coin !== market) {
          const error = createWrongMarketError(market, message.coin, {
            operation: "l2_book_validation",
            subscriptionKey: context.subscriptionKey,
          });
          await handleError(error);
          return null;
        }

        try {
          const ts = normalizeTimestamp(message.timestamp, timestampUnit);

          return {
            market: message.coin,
            ts,
            slot: BigInt(message.slot),
            bids: message.bids,
            asks: message.asks,
          };
        } catch {
          const error = createInvalidTimestampError(timestampUnit, {
            operation: "timestamp_normalization",
            subscriptionKey: context.subscriptionKey,
          });
          await handleError(error);
          return null;
        }
      },
      schemaErrorMessage: "Failed to parse L2Book message",
    },
    opts
  );
};
