import type { L2BookUpdate } from "./wire";

export type L2BookPort = (
  market: string,
  signal?: AbortSignal
) => AsyncIterable<L2BookUpdate>;
