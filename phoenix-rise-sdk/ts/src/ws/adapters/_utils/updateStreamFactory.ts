import { createAsyncQueue } from "../../AsyncQueue";
import type { WsClient } from "@/ws/types";
import type { ZodSchema } from "zod";
import { createSubUnsubMessages } from "./createSubUnsubMessages";

export interface UpdateStreamConfig<
  TRaw,
  TUpdate,
  TParams extends unknown[] = [],
> {
  channel: string;
  schema: ZodSchema<TRaw>;
  buildKey: (...params: TParams) => string;
  buildSubParams: (...params: TParams) => Record<string, unknown>;
  processMessage: (
    message: TRaw,
    params: TParams,
    context: ProcessMessageContext
  ) => TUpdate | TUpdate[] | null | Promise<TUpdate | TUpdate[] | null>;
  errorMode?: "console" | "system";
  schemaErrorMessage?: string;
}

export interface ProcessMessageContext {
  subscriptionKey: string;
  buffer: number;
}

export interface UpdateStreamOptions {
  buffer?: number;
}

export function createUpdateStream<
  TRaw,
  TUpdate,
  TParams extends unknown[] = [],
>(
  ws: WsClient,
  config: UpdateStreamConfig<TRaw, TUpdate, TParams>,
  options?: UpdateStreamOptions
) {
  return (...args: [...TParams, AbortSignal?]): AsyncIterable<TUpdate> => {
    const lastArg = args[args.length - 1];
    const signal = lastArg instanceof AbortSignal ? lastArg : undefined;
    const params = (signal ? args.slice(0, -1) : args) as TParams;

    const { buffer = 2048 } = options ?? {};
    const { errorMode = "console" } = config;

    const queue = createAsyncQueue<TUpdate>(buffer, "drop-oldest");
    const key = config.buildKey(...params);
    const subParams = config.buildSubParams(...params);

    const { sub, unsub } = createSubUnsubMessages(config.channel, subParams);

    const context: ProcessMessageContext = {
      subscriptionKey: key,
      buffer,
    };

    const onMessage = (raw: unknown) => {
      void (async () => {
        const parsed = config.schema.safeParse(raw);

        if (!parsed.success) {
          if (errorMode === "console") {
            const errorMsg =
              config.schemaErrorMessage ||
              `Failed to parse ${config.channel} message`;

            const serialize = (value: unknown) =>
              JSON.stringify(
                value,
                (_key: string, val: unknown) =>
                  typeof val === "bigint" ? val.toString() : val,
                2
              );

            console.error(
              `${errorMsg}:`,
              parsed.error,
              typeof raw === "string" ? raw : serialize(raw)
            );
          }
          return;
        }

        const result = await config.processMessage(
          parsed.data,
          params,
          context
        );

        if (result === null) {
          return;
        }

        if (Array.isArray(result)) {
          for (const update of result) {
            queue.push(update);
          }
        } else {
          queue.push(result);
        }
      })();
    };

    ws.subscribe(key, sub, onMessage);

    signal?.addEventListener("abort", () => {
      ws.unsubscribe(key, unsub);
      queue.close();
    });

    return queue;
  };
}
