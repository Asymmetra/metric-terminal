import type { PhoenixInstructionAddressSource } from "@/core/constants";
import { phoenixInstructionAddresses } from "@/core/constants";
import type { Authority, TraderAddress } from "@/primitives";
import { getPhoenixTraderSubaccountAddress } from "@/pdas";
import { buildSyncTraderCapabilitiesIx } from "./ix";
import type { SyncTraderCapabilitiesIx } from "./types";

export const buildSyncTraderCapabilities = async (params: {
  traderWallet: Authority;
  traderPdaIndex: number;
  traderSubaccountIndex: number;
  phoenixAddresses?: PhoenixInstructionAddressSource;
}): Promise<SyncTraderCapabilitiesIx> => {
  const {
    traderWallet,
    traderPdaIndex,
    traderSubaccountIndex,
    phoenixAddresses,
  } = params;

  const parentTraderAccount: TraderAddress =
    await getPhoenixTraderSubaccountAddress({
      authority: traderWallet,
      traderPdaIndex,
      subaccountIndex: 0,
      phoenixProgramAddress: phoenixAddresses?.phoenixProgramAddress,
    });

  const childTraderAccount: TraderAddress =
    await getPhoenixTraderSubaccountAddress({
      authority: traderWallet,
      traderPdaIndex,
      subaccountIndex: traderSubaccountIndex,
      phoenixProgramAddress: phoenixAddresses?.phoenixProgramAddress,
    });

  return buildSyncTraderCapabilitiesIx({
    ...(phoenixAddresses ? phoenixInstructionAddresses(phoenixAddresses) : {}),
    traderWallet,
    parentTraderAccount,
    childTraderAccount,
  });
};
