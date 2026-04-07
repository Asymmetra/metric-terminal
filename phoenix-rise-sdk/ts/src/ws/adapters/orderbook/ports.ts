import type { OrderbookSnapshotUpdate } from "./wire";

export type OrderbookPort = (
  symbol: string,
  signal?: AbortSignal
) => AsyncIterable<OrderbookSnapshotUpdate>;
