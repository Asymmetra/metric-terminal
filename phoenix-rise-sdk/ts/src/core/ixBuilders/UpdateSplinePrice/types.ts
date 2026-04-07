import type { PhoenixInstructionAddressOverrides } from "@/core/constants";
import type { Authority, MarketAddress } from "@/primitives";
import type { InstructionsWithAccountsAndData } from "@/primitives/_utilityTypes";
import type { AccountMeta } from "@solana/kit";

export interface UpdateSplinePriceParams extends PhoenixInstructionAddressOverrides {
  trader: Authority;
  marketAccount: MarketAddress;
  newMidPrice: bigint;
  userUpdateSlot?: bigint | null;
  refreshRegions?: boolean;
}

export type UpdateSplinePriceIx = InstructionsWithAccountsAndData;

export type UpdateSplinePriceAccounts = readonly AccountMeta[];
