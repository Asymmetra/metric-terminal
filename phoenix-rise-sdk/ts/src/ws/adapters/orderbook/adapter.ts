import { createUpdateStream } from "@/ws/adapters/_utils";
import { handleError } from "@/ws/errorHandling/ErrorSystem";
import { createWrongSymbolError } from "@/ws/errorHandling/errors";
import type { WsClient } from "@/ws/types";
import type { OrderbookPort } from "./ports";
import {
  OrderbookMsgSchema,
  type OrderbookMsg,
  type OrderbookSnapshotUpdate,
} from "./wire";
import { applyStrictModeRecursive } from "@/ws/zodStrictMode";

export type OrderbookAdapter = OrderbookPort;

export interface OrderbookAdapterOptions {
  buffer?: number;
}

export const createOrderbookAdapter = (
  ws: WsClient,
  opts?: OrderbookAdapterOptions,
  strictMode?: boolean
): OrderbookAdapter => {
  const schema = strictMode
    ? applyStrictModeRecursive(OrderbookMsgSchema)
    : OrderbookMsgSchema;

  return createUpdateStream<
    OrderbookMsg,
    OrderbookSnapshotUpdate,
    [symbol: string]
  >(
    ws,
    {
      channel: "orderbook",
      schema,
      buildKey: (symbol: string) => `orderbook:${symbol}`,
      buildSubParams: (symbol: string) => ({ symbol }),
      processMessage: async (message, [symbol], context) => {
        if (message.symbol !== symbol) {
          const error = createWrongSymbolError(symbol, message.symbol, {
            operation: "orderbook_snapshot_validation",
            subscriptionKey: context.subscriptionKey,
          });
          await handleError(error);
          return null;
        }

        return {
          symbol: message.symbol,
          orderbook: message.orderbook,
        };
      },
      schemaErrorMessage: "Failed to parse Orderbook message",
    },
    opts
  );
};
