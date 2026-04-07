import type { PhoenixInstructionAddressOverrides } from "@/core/constants";
import type { TraderAddress } from "@/primitives";
import type { InstructionsWithAccountsAndData } from "@/primitives/_utilityTypes";
import type { AccountMeta, Address } from "@solana/kit";

export interface SyncTraderCapabilitiesParams extends PhoenixInstructionAddressOverrides {
  traderWallet: Address;
  parentTraderAccount: TraderAddress;
  childTraderAccount: TraderAddress;
}

export type SyncTraderCapabilitiesIx = InstructionsWithAccountsAndData;

export type SyncTraderCapabilitiesAccounts = readonly AccountMeta[];
