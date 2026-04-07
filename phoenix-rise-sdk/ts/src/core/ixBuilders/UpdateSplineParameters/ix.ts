import { getPhoenixInstructionAddresses } from "@/core/constants";
import {
  generateReadonlyAccount,
  generateReadonlySignerAccount,
  generateWritableAccount,
} from "@/core/utils/accountMeta";
import { getUpdateSplineParametersEncoder } from "./codec";
import type {
  UpdateSplineParametersAccounts,
  UpdateSplineParametersIx,
  UpdateSplineParametersParams,
} from "./types";

export const buildUpdateSplineParametersIx = (
  params: UpdateSplineParametersParams
): UpdateSplineParametersIx => {
  validate(params);
  const { programAddress, logAuthorityAddress } =
    getPhoenixInstructionAddresses(params);

  const data = getUpdateSplineParametersEncoder().encode({
    bidRegions: params.bidRegions,
    askRegions: params.askRegions,
    refreshRegions: params.refreshRegions ?? false,
  });

  const accounts: UpdateSplineParametersAccounts = [
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

const validate = (params: UpdateSplineParametersParams) => {
  if (!params.trader) {
    throw new Error("Trader wallet is required");
  }
  if (!params.marketAccount) {
    throw new Error("Market account address is required");
  }
  if (!params.bidRegions || params.bidRegions.length === 0) {
    if (!params.askRegions || params.askRegions.length === 0) {
      throw new Error("At least one region (bid or ask) must be provided");
    }
  }

  for (let i = 0; i < params.bidRegions.length; i++) {
    const region = params.bidRegions[i];

    if (!region) {
      throw new Error(`Bid region ${i}: missing region definition`);
    }
    if (region.endOffset <= region.startOffset) {
      throw new Error(
        `Bid region ${i}: End offset must be greater than start offset`
      );
    }
    if (region.density <= 0n) {
      throw new Error(`Bid region ${i}: Density must be greater than zero`);
    }
  }

  for (let i = 0; i < params.askRegions.length; i++) {
    const region = params.askRegions[i];

    if (!region) {
      throw new Error(`Ask region ${i}: missing region definition`);
    }
    if (region.endOffset <= region.startOffset) {
      throw new Error(
        `Ask region ${i}: End offset must be greater than start offset`
      );
    }
    if (region.density <= 0n) {
      throw new Error(`Ask region ${i}: Density must be greater than zero`);
    }
  }
};
