import { getPhoenixInstructionAddresses } from "@/core/constants";
import {
  generateReadonlyAccount,
  generateReadonlySignerAccount,
  generateWritableAccount,
} from "@/core/utils/accountMeta";
import { getUpdateSplinePriceEncoder } from "./codec";
import type {
  UpdateSplinePriceAccounts,
  UpdateSplinePriceIx,
  UpdateSplinePriceParams,
} from "./types";

export const buildUpdateSplinePriceIx = (
  params: UpdateSplinePriceParams
): UpdateSplinePriceIx => {
  validate(params);
  const { programAddress, logAuthorityAddress } =
    getPhoenixInstructionAddresses(params);

  const data = getUpdateSplinePriceEncoder().encode({
    newMidPrice: params.newMidPrice,
    userUpdateSlot: params.userUpdateSlot ?? null,
    refreshRegions: params.refreshRegions ?? false,
  });

  const accounts: UpdateSplinePriceAccounts = [
    generateReadonlyAccount(programAddress),
    generateReadonlyAccount(logAuthorityAddress),
    generateReadonlySignerAccount(params.trader),
    generateWritableAccount(params.trader),
    generateWritableAccount(params.marketAccount),
  ] as const;

  return {
    programAddress,
    accounts,
    data,
  };
};

const validate = (params: UpdateSplinePriceParams) => {
  if (!params.trader) {
    throw new Error("Trader wallet is required");
  }
  if (!params.marketAccount) {
    throw new Error("Market account address is required");
  }
  if (params.newMidPrice < 0n) {
    throw new Error("New mid price must be non-negative");
  }
  if (
    params.userUpdateSlot !== undefined &&
    params.userUpdateSlot !== null &&
    params.userUpdateSlot < 0n
  ) {
    throw new Error("User update slot must be non-negative");
  }
};
