import { getPhoenixInstructionAddresses } from "@/core/constants";
import {
  generateReadonlyAccount,
  generateWritableAccount,
} from "@/core/utils/accountMeta";
import { DISCRIMINANTS } from "@/core/discriminants";
import type {
  SyncTraderCapabilitiesAccounts,
  SyncTraderCapabilitiesIx,
  SyncTraderCapabilitiesParams,
} from "./types";

export const buildSyncTraderCapabilitiesIx = (
  params: SyncTraderCapabilitiesParams
): SyncTraderCapabilitiesIx => {
  validate(params);
  const { programAddress, logAuthorityAddress, globalConfigurationAddress } =
    getPhoenixInstructionAddresses(params);

  const accounts: SyncTraderCapabilitiesAccounts = [
    generateReadonlyAccount(programAddress),
    generateReadonlyAccount(logAuthorityAddress),
    generateReadonlyAccount(globalConfigurationAddress),
    generateReadonlyAccount(params.traderWallet),
    generateReadonlyAccount(params.parentTraderAccount),
    generateWritableAccount(params.childTraderAccount),
  ] as const;

  return {
    programAddress,
    accounts,
    data: DISCRIMINANTS.SYNC_TRADER_CAPABILITIES,
  };
};

const validate = (params: SyncTraderCapabilitiesParams) => {
  if (!params.traderWallet) {
    throw new Error("Trader wallet is required");
  }
  if (!params.parentTraderAccount) {
    throw new Error("Parent trader account is required");
  }
  if (!params.childTraderAccount) {
    throw new Error("Child trader account is required");
  }
  if (params.childTraderAccount === params.parentTraderAccount) {
    throw new Error("Child and parent trader accounts must be different");
  }
};
