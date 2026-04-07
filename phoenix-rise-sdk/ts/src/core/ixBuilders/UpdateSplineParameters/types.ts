import type { PhoenixInstructionAddressOverrides } from "@/core/constants";
import type {
  Authority,
  BaseLotsPerTick,
  MarketAddress,
  Ticks,
} from "@/primitives";
import type { InstructionsWithAccountsAndData } from "@/primitives/_utilityTypes";
import type { AccountMeta } from "@solana/kit";

export interface TickRegionParams {
  startOffset: Ticks;
  endOffset: Ticks;
  density: BaseLotsPerTick;
}

export interface UpdateSplineParametersParams extends PhoenixInstructionAddressOverrides {
  trader: Authority;
  marketAccount: MarketAddress;
  bidRegions: TickRegionParams[];
  askRegions: TickRegionParams[];
  refreshRegions?: boolean;
}

export type UpdateSplineParametersIx = InstructionsWithAccountsAndData;

export type UpdateSplineParametersAccounts = readonly AccountMeta[];
