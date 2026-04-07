import { AccountFetchers, fetchPerpAssetMap, fetchTrader } from "@/accounts";
import {
  getSequenceNumberDecoder,
  type SequenceNumber,
} from "@/accounts/internal";
import {
  DEFAULT_MARKET_ORDER_SLIPPAGE,
  SPL_ATA_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "@/core/constants";
import type { PhoenixInstructionClient } from "@/core/clientTypes";
import { ACCOUNT_DISCRIMINANTS } from "@/core/discriminants";
import { getFixedLengthArrayCodec } from "@/primitives/_utilityTypes/FixedLengthArray";
import type { InstructionsWithAccountsAndData } from "@/primitives/_utilityTypes";
import {
  type ActiveTraderBufferAddressArray,
  type ActiveTraderBufferArenaAddress,
  type Authority,
  type EmberStateAddress,
  type GlobalTraderIndexAddressArray,
  type GlobalTraderIndexArenaAddress,
  type MarketAddress,
  type MintAddress,
  type PhoenixProgramAddress,
  type SPLTokenProgramAddress,
  type TokenAccountAddress,
  type TraderAddress,
} from "@/primitives";
import { MarginType, type Symbol, toMaxPositions } from "@/primitives";
import {
  getPhoenixTraderSubaccountAddress,
  getPhoenixTraderTokenAccountAddress,
} from "@/pdas";
import {
  generateReadonlyAccount,
  generateReadonlySignerAccount,
  generateWritableAccount,
  generateWritableSignerAccount,
} from "@/core/utils/accountMeta";
import {
  getConstantDecoder,
  getHiddenPrefixDecoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU16Decoder,
  getU32Codec,
  getU32Decoder,
  getU8Codec,
  transformDecoder,
  type Address,
  type Decoder,
} from "@solana/kit";

export interface RequiredAccounts {
  globalConfiguration: Awaited<
    ReturnType<typeof AccountFetchers.GlobalConfiguration>
  >;
  arenaAddresses: ActiveTraderBufferAddressArray;
  globalTraderIndexAddresses: GlobalTraderIndexAddressArray;
}

export interface MarketMetadataForSymbol {
  marketAddress: MarketAddress;
  assetId: bigint;
}

export interface SubaccountInfo {
  index: number;
  authority: Authority;
  address: TraderAddress;
  maxPositions: bigint;
}

interface Superblock {
  size: number;
  numArenas: number;
  numActiveArenas: number;
  numNodesPerArena: number;
  bumpIndex: number;
  freeListHead: number;
}

interface ArenaHeader {
  sequenceNumber: SequenceNumber;
  numAdditionalNodes: number;
  superblock: Superblock;
  root: number;
}

export const MAX_SUBACCOUNTS = 255;

const getSuperblockDecoder = (): Decoder<Superblock> =>
  transformDecoder(
    getStructDecoder([
      ["size", getU32Decoder()],
      ["numArenas", getU16Decoder()],
      ["numActiveArenas", getU16Decoder()],
      ["numNodesPerArena", getU32Decoder()],
      ["bumpIndex", getU32Decoder()],
      ["freeListHead", getU32Decoder()],
      ["_padding", getFixedLengthArrayCodec(getU32Codec(), 3)],
    ]),
    ({ _padding, ...superblock }) => superblock
  );

const getArenaHeaderDecoder = (
  discriminant: Uint8Array
): Decoder<ArenaHeader> =>
  transformDecoder(
    getHiddenPrefixDecoder(
      getStructDecoder([
        ["sequenceNumber", getSequenceNumberDecoder()],
        ["numAdditionalNodes", getU32Decoder()],
        ["_padding0", getFixedLengthArrayCodec(getU8Codec(), 4)],
        ["_padding1", getFixedLengthArrayCodec(getU8Codec(), 16)],
        ["superblock", getSuperblockDecoder()],
        ["root", getU32Decoder()],
        ["_padding2", getFixedLengthArrayCodec(getU32Codec(), 3)],
      ]),
      [getConstantDecoder(discriminant)]
    ),
    ({ _padding0, _padding1, _padding2, ...header }) => header
  );

const getArenaIndices = (superblock: Superblock) => {
  const numArenas = superblock.numArenas >>> 0;
  const numActiveArenas = superblock.numActiveArenas >>> 0;
  const arenaIndices: number[] = [];
  const arenasToFetch = Math.max(0, Math.min(numArenas, numActiveArenas) - 1);
  for (let i = 1; i <= arenasToFetch; i++) {
    arenaIndices.push(i);
  }
  return arenaIndices;
};

export const getArenaAddresses = async <
  T extends ActiveTraderBufferArenaAddress[] | GlobalTraderIndexArenaAddress[] =
    | ActiveTraderBufferArenaAddress[]
    | GlobalTraderIndexArenaAddress[],
>(
  arenaIndices: number[],
  pdaSeed: string,
  programAddress: PhoenixProgramAddress
): Promise<T> => {
  const arenaAddresses = await Promise.all(
    arenaIndices.map(async (index) => {
      const [pda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [pdaSeed, new Uint8Array([index])],
      });
      return pda;
    })
  );

  return arenaAddresses as T;
};

const decodeArenaHeader = async (
  client: PhoenixInstructionClient,
  address: Address,
  discriminant: Uint8Array
): Promise<ArenaHeader> => {
  const account = await client.fetchAccount(address);
  return getArenaHeaderDecoder(discriminant).decode(account.data);
};

export const getActiveTraderBufferAddresses = async (
  client: PhoenixInstructionClient
): Promise<ActiveTraderBufferAddressArray> => {
  const globalConfiguration = await AccountFetchers.GlobalConfiguration({
    client,
    address: client.addresses.globalConfigurationAddress,
  });

  const headerAddress = globalConfiguration.activeTraderBufferHeaderKey;
  const header = await decodeArenaHeader(
    client,
    headerAddress,
    ACCOUNT_DISCRIMINANTS.ACTIVE_TRADER_BUFFER_HEADER
  );
  const arenaAddresses = await getArenaAddresses<
    ActiveTraderBufferArenaAddress[]
  >(
    getArenaIndices(header.superblock),
    "active_trader_buffer",
    client.addresses.phoenixProgramAddress
  );

  return [headerAddress, ...arenaAddresses];
};

export const getGlobalTraderIndexAddresses = async (
  client: PhoenixInstructionClient
): Promise<GlobalTraderIndexAddressArray> => {
  const globalConfiguration = await AccountFetchers.GlobalConfiguration({
    client,
    address: client.addresses.globalConfigurationAddress,
  });

  const headerAddress = globalConfiguration.globalTraderIndexHeaderKey;
  const header = await decodeArenaHeader(
    client,
    headerAddress,
    ACCOUNT_DISCRIMINANTS.GLOBAL_TRADER_INDEX_HEADER
  );
  const arenaAddresses = await getArenaAddresses<
    GlobalTraderIndexArenaAddress[]
  >(
    getArenaIndices(header.superblock),
    "global_trader_index",
    client.addresses.phoenixProgramAddress
  );

  return [headerAddress, ...arenaAddresses];
};

export const fetchRequiredAccounts = async (
  client: PhoenixInstructionClient
): Promise<RequiredAccounts> => {
  const [globalConfiguration, arenaAddresses, globalTraderIndexAddresses] =
    await Promise.all([
      AccountFetchers.GlobalConfiguration({
        client,
        address: client.addresses.globalConfigurationAddress,
      }),
      getActiveTraderBufferAddresses(client),
      getGlobalTraderIndexAddresses(client),
    ]);

  return {
    globalConfiguration,
    arenaAddresses,
    globalTraderIndexAddresses,
  };
};

export const getMarketMetadataForSymbol = async (
  symbol: Symbol,
  client: PhoenixInstructionClient
): Promise<MarketMetadataForSymbol> => {
  const globalConfiguration = await AccountFetchers.GlobalConfiguration({
    client,
    address: client.addresses.globalConfigurationAddress,
  });
  const perpAssetMap = await fetchPerpAssetMap({
    client,
    address: globalConfiguration.perpAssetMapKey,
  });

  const assetMetadata = perpAssetMap.metadata.entries.find(
    ({ key }) => key.toUpperCase() === symbol.toUpperCase()
  )?.value;
  if (!assetMetadata) {
    throw new Error(`Market for symbol '${symbol}' not found in PerpAssetMap`);
  }

  return {
    marketAddress: assetMetadata.staticMarketParams.marketAccount,
    assetId: BigInt(assetMetadata.staticMarketParams.assetId),
  };
};

export const getMarketAddressForSymbol = async (
  symbol: Symbol,
  client: PhoenixInstructionClient
): Promise<MarketAddress> =>
  (await getMarketMetadataForSymbol(symbol, client)).marketAddress;

export const deriveTraderAddresses = (
  authority: Authority,
  traderPdaIndex: number,
  subaccountIndex: number,
  phoenixProgramAddress?: PhoenixProgramAddress
): {
  traderAccount: () => Promise<TraderAddress>;
  traderTokenAccount: (mint: MintAddress) => Promise<TokenAccountAddress>;
} => ({
  traderAccount: () =>
    getPhoenixTraderSubaccountAddress({
      authority,
      traderPdaIndex,
      subaccountIndex,
      phoenixProgramAddress,
    }),
  traderTokenAccount: (mint: MintAddress) =>
    getPhoenixTraderTokenAccountAddress(authority, mint),
});

export const getTraderAddresses = async (
  authority: Authority,
  mint: MintAddress,
  traderPdaIndex: number,
  traderSubaccountIndex: number,
  phoenixProgramAddress?: PhoenixProgramAddress
): Promise<{
  traderAccount: TraderAddress;
  traderTokenAccount: TokenAccountAddress;
}> => {
  const [traderAccount, traderTokenAccount] = await Promise.all([
    getPhoenixTraderSubaccountAddress({
      authority,
      traderPdaIndex,
      subaccountIndex: traderSubaccountIndex,
      phoenixProgramAddress,
    }),
    getPhoenixTraderTokenAccountAddress(authority, mint),
  ]);

  return {
    traderAccount,
    traderTokenAccount,
  };
};

export const getClientTraderAddresses = async (
  client: Pick<PhoenixInstructionClient, "addresses">,
  authority: Authority,
  mint: MintAddress,
  traderPdaIndex: number,
  traderSubaccountIndex: number
): Promise<{
  traderAccount: TraderAddress;
  traderTokenAccount: TokenAccountAddress;
}> =>
  getTraderAddresses(
    authority,
    mint,
    traderPdaIndex,
    traderSubaccountIndex,
    client.addresses.phoenixProgramAddress
  );

export const fetchSubaccountForAsset = async (
  client: PhoenixInstructionClient,
  authority: Authority,
  traderPdaIndex: number,
  marginType: MarginType,
  assetId: number
): Promise<SubaccountInfo> => {
  const maxPositions = toMaxPositions(marginType);

  for (let index = 0; index <= MAX_SUBACCOUNTS; index++) {
    const subaccountAddress = await getPhoenixTraderSubaccountAddress({
      authority,
      traderPdaIndex,
      subaccountIndex: index,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    });

    try {
      const trader = await fetchTrader({
        client,
        address: subaccountAddress,
        skipCache: true,
      });

      if (trader.maxPositions !== maxPositions) {
        continue;
      }

      let isSuitable = false;
      if (trader.positions.len === 0n) {
        isSuitable = true;
      } else if (marginType === MarginType.Isolated) {
        isSuitable = trader.positions.entries.some(
          ({ key }) => key === BigInt(assetId)
        );
      } else {
        isSuitable = true;
      }

      if (isSuitable) {
        return {
          index,
          authority,
          address: subaccountAddress,
          maxPositions,
        };
      }
    } catch {
      continue;
    }
  }

  const marginTypeStr =
    marginType === MarginType.Isolated ? "isolated" : "cross";

  throw new Error(
    `No suitable ${marginTypeStr} subaccount found for trader ${authority} and asset ${assetId}. ` +
      `For isolated margin, you need either an empty subaccount or one with an existing position in asset ${assetId}.`
  );
};

export const buildCreateAssociatedTokenAccountIdempotent = async (params: {
  payer: Authority;
  owner: Authority;
  mint: MintAddress;
  tokenProgram?: SPLTokenProgramAddress;
}): Promise<InstructionsWithAccountsAndData> => {
  const {
    payer,
    owner,
    mint,
    tokenProgram = SPL_TOKEN_PROGRAM_ADDRESS,
  } = params;
  const ataAddress = await getPhoenixTraderTokenAccountAddress(owner, mint);

  return buildCreateAssociatedTokenAccountIdempotentSync({
    payer,
    ataAddress,
    owner,
    mint,
    tokenProgram,
  });
};

export const buildCreateAssociatedTokenAccountIdempotentSync = (params: {
  payer: Authority;
  ataAddress: Address;
  owner: Authority;
  mint: MintAddress;
  tokenProgram?: SPLTokenProgramAddress;
}): InstructionsWithAccountsAndData => {
  const {
    payer,
    ataAddress,
    owner,
    mint,
    tokenProgram = SPL_TOKEN_PROGRAM_ADDRESS,
  } = params;

  return {
    programAddress: SPL_ATA_PROGRAM_ADDRESS,
    accounts: [
      generateWritableSignerAccount(payer),
      generateWritableAccount(ataAddress),
      generateReadonlyAccount(owner),
      generateReadonlyAccount(mint),
      generateReadonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      generateReadonlyAccount(tokenProgram),
    ] as const,
    data: new Uint8Array([1]),
  };
};

export const buildSplTokenApprove = (params: {
  owner: Authority;
  tokenAccount: TokenAccountAddress;
  delegate: Authority | EmberStateAddress;
  amount: bigint;
}): InstructionsWithAccountsAndData => {
  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, params.amount, true);

  const data = new Uint8Array(9);
  data.set([4], 0);
  data.set(amountBytes, 1);

  return {
    programAddress: SPL_TOKEN_PROGRAM_ADDRESS,
    accounts: [
      generateWritableAccount(params.tokenAccount),
      generateReadonlyAccount(params.delegate),
      generateReadonlySignerAccount(params.owner),
    ] as const,
    data,
  };
};

export { DEFAULT_MARKET_ORDER_SLIPPAGE };
