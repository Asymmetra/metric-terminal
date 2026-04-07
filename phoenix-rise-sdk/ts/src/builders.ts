import { fetchPerpAssetMap } from "@/accounts";
import {
  type PhoenixAccountExistenceClient,
  type PhoenixInstructionClient,
  type PhoenixTransactionClient,
  type SendInstructionOptions,
} from "@/core/clientTypes";
import {
  clientPhoenixInstructionAddresses,
  phoenixInstructionAddresses,
} from "@/core/constants";
import {
  fetchRequiredAccounts,
  getClientTraderAddresses,
  getMarketAddressForSymbol,
  getMarketMetadataForSymbol,
  MAX_SUBACCOUNTS,
} from "@/core/helpers";
import {
  type Authority,
  type CancelId,
  type Direction,
  MarginType,
  type Side,
  type StopLossOrderKind,
  type Symbol,
  ticks,
  toMaxPositions,
} from "@/primitives";
import {
  getEmberVaultAddress,
  getPhoenixEscrowAddress,
  getPhoenixGlobalVaultAddress,
  getPhoenixPermissionAddress,
  getPhoenixSplineCollectionAddress,
  getPhoenixStopLossAddress,
  getPhoenixTraderSubaccountAddress,
  getPhoenixTraderTokenAccountAddress,
} from "@/pdas";
import type { Address, Signature } from "@solana/kit";
import {
  buildCancelAllIx,
  type CancelAllIx,
} from "./core/ixBuilders/CancelAll";
import {
  buildCancelOrdersByIdIx,
  type CancelOrdersByIdIx,
} from "./core/ixBuilders/CancelOrdersById";
import {
  buildCancelStopLossIx,
  type CancelStopLossIx,
} from "./core/ixBuilders/CancelStopLoss";
import {
  buildCreateEscrowRequestIx,
  type CreateEscrowRequestIx,
  type EscrowAction,
} from "./core/ixBuilders/CreateEscrowRequest";
import {
  buildDelegateTraderIx,
  type DelegateTraderIx,
} from "./core/ixBuilders/DelegateTrader";
import {
  buildDepositFundsIx,
  type DepositFundsIx,
} from "./core/ixBuilders/DepositFunds";
import {
  buildEmberDepositIx,
  type EmberDepositIx,
} from "./core/ixBuilders/EmberDeposit";
import {
  buildEmberWithdrawIx,
  type EmberWithdrawIx,
} from "./core/ixBuilders/EmberWithdraw";
import {
  buildPlaceLimitOrderIx,
  type PlaceLimitOrderIx,
} from "./core/ixBuilders/PlaceLimitOrder";
import {
  buildPlaceMarketOrderIx,
  type PlaceMarketOrderIx,
} from "./core/ixBuilders/PlaceMarketOrder";
import {
  buildPlacePostOnlyOrderIx,
  type PlacePostOnlyOrderIx,
} from "./core/ixBuilders/PlacePostOnlyOrder";
import {
  buildPlaceStopLossIx,
  type PlaceStopLossIx,
} from "./core/ixBuilders/PlaceStopLoss";
import {
  buildRegisterTraderIx,
  type RegisterTraderIx,
} from "./core/ixBuilders/RegisterTrader";
import {
  buildSyncParentToChildIx,
  type SyncParentToChildIx,
} from "./core/ixBuilders/SyncParentToChild";
import {
  buildTransferCollateralChildToParentIx,
  type TransferCollateralChildToParentIx,
} from "./core/ixBuilders/TransferCollateralChildToParent";
import {
  buildTransferCollateralIx,
  type TransferCollateralIx,
} from "./core/ixBuilders/TransferCollateral";
import {
  buildWithdrawFundsIx,
  type WithdrawFundsIx,
} from "./core/ixBuilders/WithdrawFunds";
import type {
  ImmediateOrCancelOrderPacket,
  LimitOrderPacket,
  PostOnlyOrderPacket,
} from "@/primitives";

type Commitment = SendInstructionOptions["commitment"];

type SponsorshipUserIdentifier = {
  userId?: string;
  userPubkey?: Authority;
};

interface BaseBuildRegisterTraderParams {
  authority: Authority;
  marginType: MarginType;
  traderPdaIndex?: number;
  traderSubaccountIndex?: number;
}

type SponsoredBuildRegisterTraderParams = BaseBuildRegisterTraderParams &
  SponsorshipUserIdentifier & {
    feePayer: Authority;
    sponsorshipToken: string;
  };

interface NonSponsoredBuildRegisterTraderParams extends BaseBuildRegisterTraderParams {
  feePayer?: null;
}

export type BuildRegisterTraderParams =
  | SponsoredBuildRegisterTraderParams
  | NonSponsoredBuildRegisterTraderParams;

export const buildCancelAll = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    symbol: Symbol;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<CancelAllIx> => {
  const { authority, positionAuthority, symbol } = params;
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount } = await getClientTraderAddresses(
    client,
    authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const marketAddress = await getMarketAddressForSymbol(symbol, client);
  const splineCollection = await getPhoenixSplineCollectionAddress(
    marketAddress,
    client.addresses.phoenixProgramAddress
  );

  return buildCancelAllIx({
    ...clientPhoenixInstructionAddresses(client),
    traderWallet: positionAuthority ?? authority,
    traderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    orderbook: marketAddress,
    splineCollection,
  });
};

export const cancelAllOrders = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    symbol: Symbol;
  },
  options: {
    traderPdaIndex?: number;
    commitment?: Commitment;
  } = {}
): Promise<Signature> => {
  const ix = await buildCancelAll(params, client, options.traderPdaIndex ?? 0);
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildCancelOrdersById = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    symbol: Symbol;
    orders: Array<{
      price: number | bigint;
      orderSequenceNumber: string | number;
    }>;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<CancelOrdersByIdIx> => {
  const { authority, positionAuthority, symbol, orders } = params;
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const perpAssetMap = await fetchPerpAssetMap({
    client,
    address: globalConfiguration.perpAssetMapKey,
  });
  const assetEntry = perpAssetMap.metadata.entries.find(
    ({ key }) => key.toUpperCase() === symbol.toUpperCase()
  );

  if (!assetEntry) {
    throw new Error(`Market not found for symbol: ${symbol}`);
  }

  const metadata = assetEntry.value;
  const tickSize = Number(metadata.staticMarketParams.tickSize);
  const baseLotDecimals = metadata.staticMarketParams.baseLotDecimals;
  const { traderAccount } = await getClientTraderAddresses(
    client,
    authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const marketAddress = await getMarketAddressForSymbol(symbol, client);
  const splineCollection = await getPhoenixSplineCollectionAddress(
    marketAddress,
    client.addresses.phoenixProgramAddress
  );

  const priceToTicks = (priceUsd: bigint | number): bigint => {
    const price = typeof priceUsd === "bigint" ? Number(priceUsd) : priceUsd;
    const priceTicks =
      (price * 1_000_000) / (tickSize * Math.pow(10, baseLotDecimals));
    return BigInt(Math.floor(priceTicks));
  };

  const orderIds: CancelId[] = orders.map((order) => ({
    nodePointer: null,
    orderId: {
      priceInTicks: ticks(priceToTicks(order.price)),
      orderSequenceNumber: BigInt(order.orderSequenceNumber),
    },
  }));

  return buildCancelOrdersByIdIx({
    ...clientPhoenixInstructionAddresses(client),
    traderWallet: positionAuthority ?? authority,
    traderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    orderbook: marketAddress,
    splineCollection,
    orderIds,
  });
};

export const cancelOrdersById = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    symbol: Symbol;
    orders: Array<{
      price: bigint;
      orderSequenceNumber: string | number;
    }>;
  },
  options: {
    traderPdaIndex?: number;
    traderSubaccountIndex?: number;
    commitment?: Commitment;
  } = {}
): Promise<Signature> => {
  const ix = await buildCancelOrdersById(
    params,
    client,
    options.traderPdaIndex ?? 0,
    options.traderSubaccountIndex ?? 0
  );
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildCancelStopLoss = async (
  params: {
    authority: Authority;
    symbol: Symbol;
    executionDirection: Direction;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<CancelStopLossIx> => {
  const { globalConfiguration } = await fetchRequiredAccounts(client);
  const { traderAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const { assetId } = await getMarketMetadataForSymbol(params.symbol, client);
  const stopLossAccount = await getPhoenixStopLossAddress({
    traderAccount,
    assetId,
    phoenixProgramAddress: client.addresses.phoenixProgramAddress,
  });

  return buildCancelStopLossIx({
    ...clientPhoenixInstructionAddresses(client),
    funder: params.authority,
    traderWallet: params.authority,
    traderAccount,
    stopLossAccount,
    executionDirection: params.executionDirection,
  });
};

export const buildCreateEscrowRequest = async (
  params: {
    senderAuthority: Authority;
    receiverAuthority: Authority;
    actions: EscrowAction[];
    senderPdaIndex?: number;
    senderSubaccountIndex?: number;
    receiverPdaIndex?: number;
    receiverSubaccountIndex?: number;
    lastValidSlot?: bigint | null;
  },
  client: PhoenixInstructionClient
): Promise<CreateEscrowRequestIx> => {
  const {
    senderAuthority,
    receiverAuthority,
    actions,
    senderPdaIndex = 0,
    senderSubaccountIndex = 0,
    receiverPdaIndex = 0,
    receiverSubaccountIndex = 0,
    lastValidSlot,
  } = params;

  const { arenaAddresses, globalTraderIndexAddresses, globalConfiguration } =
    await fetchRequiredAccounts(client);

  const [
    senderTraderAccount,
    receiverTraderAccount,
    receiverEscrow,
    permissionAccount,
  ] = await Promise.all([
    getPhoenixTraderSubaccountAddress({
      authority: senderAuthority,
      traderPdaIndex: senderPdaIndex,
      subaccountIndex: senderSubaccountIndex,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    }),
    getPhoenixTraderSubaccountAddress({
      authority: receiverAuthority,
      traderPdaIndex: receiverPdaIndex,
      subaccountIndex: receiverSubaccountIndex,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    }),
    getPhoenixEscrowAddress(
      receiverAuthority,
      client.addresses.phoenixProgramAddress
    ),
    getPhoenixPermissionAddress(
      receiverAuthority,
      senderAuthority,
      client.addresses.phoenixProgramAddress
    ),
  ]);

  return buildCreateEscrowRequestIx({
    ...clientPhoenixInstructionAddresses(client),
    senderWallet: senderAuthority,
    senderTraderAccount,
    permissionAccount,
    receiverWallet: receiverAuthority,
    receiverTraderAccount,
    receiverEscrow,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    senderPdaIndex,
    senderSubaccountIndex,
    receiverPdaIndex,
    receiverSubaccountIndex,
    actions,
    lastValidSlot,
  });
};

export const createEscrowRequest = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    senderAuthority: Authority;
    receiverAuthority: Authority;
    actions: EscrowAction[];
    senderPdaIndex?: number;
    senderSubaccountIndex?: number;
    receiverPdaIndex?: number;
    receiverSubaccountIndex?: number;
    lastValidSlot?: bigint | null;
  },
  options: SendInstructionOptions = {}
): Promise<Signature> => {
  const ix = await buildCreateEscrowRequest(params, client);
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildDelegateTrader = async (params: {
  traderWallet: Authority;
  traderPdaIndex: number;
  traderSubaccountIndex: number;
  newPositionAuthority: Address;
  phoenixAddresses?: {
    phoenixProgramAddress: PhoenixInstructionClient["addresses"]["phoenixProgramAddress"];
    logAuthorityAddress: PhoenixInstructionClient["addresses"]["logAuthorityAddress"];
    globalConfigurationAddress: PhoenixInstructionClient["addresses"]["globalConfigurationAddress"];
  };
}): Promise<DelegateTraderIx> => {
  const traderAccount = await getPhoenixTraderSubaccountAddress({
    authority: params.traderWallet,
    traderPdaIndex: params.traderPdaIndex,
    subaccountIndex: params.traderSubaccountIndex,
    phoenixProgramAddress: params.phoenixAddresses?.phoenixProgramAddress,
  });

  return buildDelegateTraderIx({
    ...(params.phoenixAddresses
      ? phoenixInstructionAddresses(params.phoenixAddresses)
      : {}),
    traderWallet: params.traderWallet,
    traderAccount,
    newPositionAuthority: params.newPositionAuthority,
  });
};

export const buildDepositFunds = async (
  params: {
    authority: Authority;
    amount: bigint;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0
): Promise<DepositFundsIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount, traderTokenAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    0
  );
  const globalVault = await getPhoenixGlobalVaultAddress(
    globalConfiguration.canonicalTokenMintKey,
    client.addresses.phoenixProgramAddress
  );

  return buildDepositFundsIx({
    ...clientPhoenixInstructionAddresses(client),
    trader: params.authority,
    traderAccount,
    mint: globalConfiguration.canonicalTokenMintKey,
    traderTokenAccount,
    globalVault,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    amount: params.amount,
  });
};

export const depositFunds = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    amount: bigint;
  },
  options: {
    traderPdaIndex?: number;
    commitment?: Commitment;
  } = {}
): Promise<Signature> => {
  const ix = await buildDepositFunds(
    params,
    client,
    options.traderPdaIndex ?? 0
  );
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildEmberDeposit = async (
  params: {
    authority: Authority;
    amount: bigint;
  },
  client: PhoenixInstructionClient
): Promise<EmberDepositIx> => {
  const { globalConfiguration } = await fetchRequiredAccounts(client);
  const inputMint = client.addresses.usdcMintAddress;
  const outputMint = globalConfiguration.canonicalTokenMintKey;
  const [inputTokenAccount, outputTokenAccount, emberVault] = await Promise.all(
    [
      getPhoenixTraderTokenAccountAddress(params.authority, inputMint),
      getPhoenixTraderTokenAccountAddress(params.authority, outputMint),
      getEmberVaultAddress(client.addresses.phoenixProgramAddress),
    ]
  );

  return buildEmberDepositIx({
    owner: params.authority,
    inputMint,
    outputMint,
    inputTokenAccount,
    outputTokenAccount,
    emberState: client.addresses.emberStateAddress,
    emberVault,
    amount: params.amount,
  });
};

export const buildEmberWithdraw = async (
  params: {
    authority: Authority;
    amount: bigint | null;
  },
  client: PhoenixInstructionClient
): Promise<EmberWithdrawIx> => {
  const { globalConfiguration } = await fetchRequiredAccounts(client);
  const inputMint = client.addresses.usdcMintAddress;
  const outputMint = globalConfiguration.canonicalTokenMintKey;
  const [inputTokenAccount, outputTokenAccount, emberVault] = await Promise.all(
    [
      getPhoenixTraderTokenAccountAddress(params.authority, inputMint),
      getPhoenixTraderTokenAccountAddress(params.authority, outputMint),
      getEmberVaultAddress(client.addresses.phoenixProgramAddress),
    ]
  );

  return buildEmberWithdrawIx({
    owner: params.authority,
    inputMint,
    outputMint,
    inputTokenAccount,
    outputTokenAccount,
    emberState: client.addresses.emberStateAddress,
    emberVault,
    amount: params.amount,
  });
};

export const buildPlaceLimitOrder = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    symbol: Symbol;
    orderPacket: LimitOrderPacket;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<PlaceLimitOrderIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const marketAddress = await getMarketAddressForSymbol(params.symbol, client);
  const splineCollection = await getPhoenixSplineCollectionAddress(
    marketAddress,
    client.addresses.phoenixProgramAddress
  );

  return buildPlaceLimitOrderIx({
    ...clientPhoenixInstructionAddresses(client),
    trader: params.positionAuthority ?? params.authority,
    traderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    orderbook: marketAddress,
    splineCollection,
    orderPacket: params.orderPacket,
  });
};

export const placeLimitOrder = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    symbol: Symbol;
    orderPacket: LimitOrderPacket;
  },
  options: {
    traderPdaIndex?: number;
    commitment?: Commitment;
  } = {}
): Promise<Signature> => {
  const ix = await buildPlaceLimitOrder(
    params,
    client,
    options.traderPdaIndex ?? 0
  );
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildPlaceMarketOrder = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    symbol: Symbol;
    orderPacket: ImmediateOrCancelOrderPacket;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<PlaceMarketOrderIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const marketAddress = await getMarketAddressForSymbol(params.symbol, client);
  const splineCollection = await getPhoenixSplineCollectionAddress(
    marketAddress,
    client.addresses.phoenixProgramAddress
  );

  return buildPlaceMarketOrderIx({
    ...clientPhoenixInstructionAddresses(client),
    trader: params.positionAuthority ?? params.authority,
    traderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    orderbook: marketAddress,
    splineCollection,
    orderPacket: params.orderPacket,
  });
};

export const placeMarketOrder = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    symbol: Symbol;
    orderPacket: ImmediateOrCancelOrderPacket;
  },
  options: {
    traderPdaIndex?: number;
    traderSubaccountIndex?: number;
    commitment?: Commitment;
  } = {}
): Promise<Signature> => {
  const ix = await buildPlaceMarketOrder(
    params,
    client,
    options.traderPdaIndex ?? 0,
    options.traderSubaccountIndex ?? 0
  );
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildPlacePostOnlyOrder = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    symbol: Symbol;
    orderPacket: PostOnlyOrderPacket;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<PlacePostOnlyOrderIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const marketAddress = await getMarketAddressForSymbol(params.symbol, client);
  const splineCollection = await getPhoenixSplineCollectionAddress(
    marketAddress,
    client.addresses.phoenixProgramAddress
  );

  return buildPlacePostOnlyOrderIx({
    ...clientPhoenixInstructionAddresses(client),
    trader: params.positionAuthority ?? params.authority,
    traderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    orderbook: marketAddress,
    splineCollection,
    orderPacket: params.orderPacket,
  });
};

export const placePostOnlyOrder = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    symbol: Symbol;
    orderPacket: PostOnlyOrderPacket;
  },
  options: {
    traderPdaIndex?: number;
    commitment?: Commitment;
  } = {}
): Promise<Signature> => {
  const ix = await buildPlacePostOnlyOrder(
    params,
    client,
    options.traderPdaIndex ?? 0
  );
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildPlaceStopLoss = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    symbol: Symbol;
    triggerPrice: bigint;
    executionPrice?: bigint;
    tradeSide: Side;
    executionDirection: Direction;
    orderKind: StopLossOrderKind;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<PlaceStopLossIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const { marketAddress, assetId } = await getMarketMetadataForSymbol(
    params.symbol,
    client
  );
  const [splineCollection, stopLossAccount] = await Promise.all([
    getPhoenixSplineCollectionAddress(
      marketAddress,
      client.addresses.phoenixProgramAddress
    ),
    getPhoenixStopLossAddress({
      traderAccount,
      assetId,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    }),
  ]);

  return buildPlaceStopLossIx({
    ...clientPhoenixInstructionAddresses(client),
    funder: params.authority,
    traderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    orderbook: marketAddress,
    splineCollection,
    positionAuthority: params.positionAuthority ?? params.authority,
    stopLossAccount,
    triggerPrice: params.triggerPrice,
    executionPrice: params.executionPrice ?? params.triggerPrice,
    tradeSide: params.tradeSide,
    executionDirection: params.executionDirection,
    orderKind: params.orderKind,
  });
};

export const buildRegisterTrader = async (
  params: BuildRegisterTraderParams,
  client: PhoenixInstructionClient & PhoenixAccountExistenceClient
): Promise<RegisterTraderIx> => {
  const {
    authority,
    marginType,
    traderSubaccountIndex,
    feePayer,
    traderPdaIndex,
  } = params;
  const payer = feePayer ?? authority;
  const normalizedPdaIndex = traderPdaIndex ?? 0;

  if (normalizedPdaIndex !== 0) {
    throw new Error("Non-zero traderPdaIndex is not yet supported.");
  }

  if (marginType === MarginType.Isolated) {
    if (traderSubaccountIndex === undefined) {
      throw new Error(
        "Trader subaccount index is required for isolated margin"
      );
    }
    if (traderSubaccountIndex === 0) {
      throw new Error("Trader subaccount index 0 is reserved for cross margin");
    }
    if (traderSubaccountIndex > MAX_SUBACCOUNTS) {
      throw new Error("Trader subaccount index is out of bounds");
    }

    const traderAccount = await getPhoenixTraderSubaccountAddress({
      authority,
      traderPdaIndex: normalizedPdaIndex,
      subaccountIndex: traderSubaccountIndex,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    });

    if (await client.accountExists(traderAccount)) {
      throw new Error("Isolated margin trader account already exists");
    }

    return buildRegisterTraderIx({
      ...clientPhoenixInstructionAddresses(client),
      payer,
      trader: authority,
      traderAccount,
      maxPositions: toMaxPositions(marginType),
      traderPdaIndex: normalizedPdaIndex,
      traderSubaccountIndex,
    });
  }

  const traderAccount = await getPhoenixTraderSubaccountAddress({
    authority,
    traderPdaIndex: normalizedPdaIndex,
    subaccountIndex: 0,
    phoenixProgramAddress: client.addresses.phoenixProgramAddress,
  });

  if (await client.accountExists(traderAccount)) {
    throw new Error("Cross-margin trader account already exists");
  }

  return buildRegisterTraderIx({
    ...clientPhoenixInstructionAddresses(client),
    payer,
    trader: authority,
    traderAccount,
    maxPositions: toMaxPositions(marginType),
    traderPdaIndex: normalizedPdaIndex,
    traderSubaccountIndex: 0,
  });
};

export const registerTrader = async (
  client: PhoenixInstructionClient &
    PhoenixAccountExistenceClient &
    PhoenixTransactionClient,
  params: BuildRegisterTraderParams,
  options: { commitment?: Commitment } = {}
): Promise<Signature> => {
  const ix = await buildRegisterTrader(params, client);
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildSyncParentToChild = async (
  params: {
    traderWallet: Authority;
    traderPdaIndex: number;
    traderSubaccountIndex: number;
  },
  client: PhoenixInstructionClient
): Promise<SyncParentToChildIx> => {
  const { globalTraderIndexAddresses } = await fetchRequiredAccounts(client);
  const [parentTraderAccount, childTraderAccount] = await Promise.all([
    getPhoenixTraderSubaccountAddress({
      authority: params.traderWallet,
      traderPdaIndex: params.traderPdaIndex,
      subaccountIndex: 0,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    }),
    getPhoenixTraderSubaccountAddress({
      authority: params.traderWallet,
      traderPdaIndex: params.traderPdaIndex,
      subaccountIndex: params.traderSubaccountIndex,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    }),
  ]);

  return buildSyncParentToChildIx({
    ...clientPhoenixInstructionAddresses(client),
    traderWallet: params.traderWallet,
    parentTraderAccount,
    childTraderAccount,
    globalTraderIndex: globalTraderIndexAddresses,
  });
};

export const buildTransferCollateral = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    traderPdaIndex: number;
    srcSubaccountIndex: number;
    dstSubaccountIndex: number;
    amount: bigint;
  },
  client: PhoenixInstructionClient
): Promise<TransferCollateralIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount: srcTraderAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    params.traderPdaIndex,
    params.srcSubaccountIndex
  );
  const { traderAccount: dstTraderAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    params.traderPdaIndex,
    params.dstSubaccountIndex
  );

  return buildTransferCollateralIx({
    ...clientPhoenixInstructionAddresses(client),
    trader: params.positionAuthority ?? params.authority,
    srcTraderAccount,
    dstTraderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    amount: params.amount,
  });
};

export const transferCollateral = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    traderPdaIndex: number;
    srcSubaccountIndex: number;
    dstSubaccountIndex: number;
    amount: bigint;
  },
  options: { commitment?: Commitment } = {}
): Promise<Signature> => {
  const ix = await buildTransferCollateral(params, client);
  return client.sendAndConfirmFromInstruction(ix, options);
};

export const buildTransferCollateralChildToParent = async (
  params: {
    authority: Authority;
    positionAuthority?: Authority;
    traderPdaIndex: number;
    childSubaccountIndex: number;
  },
  client: PhoenixInstructionClient
): Promise<TransferCollateralChildToParentIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const [childTraderAccount, parentTraderAccount] = await Promise.all([
    getPhoenixTraderSubaccountAddress({
      authority: params.authority,
      traderPdaIndex: params.traderPdaIndex,
      subaccountIndex: params.childSubaccountIndex,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    }),
    getPhoenixTraderSubaccountAddress({
      authority: params.authority,
      traderPdaIndex: params.traderPdaIndex,
      subaccountIndex: 0,
      phoenixProgramAddress: client.addresses.phoenixProgramAddress,
    }),
  ]);

  return buildTransferCollateralChildToParentIx({
    ...clientPhoenixInstructionAddresses(client),
    trader: params.positionAuthority ?? params.authority,
    childTraderAccount,
    parentTraderAccount,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
  });
};

export const buildWithdrawFunds = async (
  params: {
    authority: Authority;
    amount: bigint;
  },
  client: PhoenixInstructionClient,
  traderPdaIndex = 0,
  traderSubaccountIndex = 0
): Promise<WithdrawFundsIx> => {
  const { globalConfiguration, arenaAddresses, globalTraderIndexAddresses } =
    await fetchRequiredAccounts(client);
  const { traderAccount, traderTokenAccount } = await getClientTraderAddresses(
    client,
    params.authority,
    globalConfiguration.canonicalTokenMintKey,
    traderPdaIndex,
    traderSubaccountIndex
  );
  const globalVault = await getPhoenixGlobalVaultAddress(
    globalConfiguration.canonicalTokenMintKey,
    client.addresses.phoenixProgramAddress
  );

  return buildWithdrawFundsIx({
    ...clientPhoenixInstructionAddresses(client),
    trader: params.authority,
    traderAccount,
    mint: globalConfiguration.canonicalTokenMintKey,
    perpAssetMap: globalConfiguration.perpAssetMapKey,
    destinationTokenAccount: traderTokenAccount,
    globalVault,
    withdrawQueue: globalConfiguration.withdrawQueueKey,
    globalTraderIndex: globalTraderIndexAddresses,
    activeTraderBuffer: arenaAddresses,
    amount: params.amount,
  });
};

export const withdrawFunds = async (
  client: PhoenixInstructionClient & PhoenixTransactionClient,
  params: {
    authority: Authority;
    amount: bigint;
  },
  options: {
    traderPdaIndex?: number;
    commitment?: Commitment;
  } = {}
): Promise<Signature> => {
  const ix = await buildWithdrawFunds(
    params,
    client,
    options.traderPdaIndex ?? 0
  );
  return client.sendAndConfirmFromInstruction(ix, options);
};
