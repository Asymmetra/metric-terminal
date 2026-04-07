import {
  ACCOUNT_DISCRIMINANTS,
  decodeMint,
  decodeGlobalConfiguration,
  decodeOrderbook,
  decodeOrderbookHeader,
  decodePerpAssetMap,
  decodeSplineCollection,
  decodeStopLosses,
  decodeTokenAccount,
  decodeTrader,
  decodeWithdrawQueueHeader,
  Direction,
  Side,
  StopLossOrderKind,
  TokenAccountState,
} from "@/index";
import { getAddressDecoder } from "@solana/kit";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const MOCKS_DIR = resolve(TESTS_DIR, "mocks");

type FixtureFile = {
  account: {
    data: [string, string];
  };
};

const addressFromFill = (fill: number): string =>
  getAddressDecoder().decode(new Uint8Array(32).fill(fill));

const writeU32LE = (bytes: Uint8Array, offset: number, value: number): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(offset, value, true);
};

const writeI32LE = (bytes: Uint8Array, offset: number, value: number): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setInt32(offset, value, true);
};

const writeU64LE = (bytes: Uint8Array, offset: number, value: bigint): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setBigUint64(offset, value, true);
};

const writeAddress = (
  bytes: Uint8Array,
  offset: number,
  fill: number
): void => {
  bytes.fill(fill, offset, offset + 32);
};

const createMintBytes = (): Uint8Array => {
  const bytes = new Uint8Array(82);
  writeU32LE(bytes, 0, 1);
  writeAddress(bytes, 4, 7);
  writeU64LE(bytes, 36, 1_234_567n);
  bytes[44] = 6;
  bytes[45] = 1;
  writeU32LE(bytes, 46, 1);
  writeAddress(bytes, 50, 9);
  return bytes;
};

const createTokenAccountBytes = (): Uint8Array => {
  const bytes = new Uint8Array(165);
  writeAddress(bytes, 0, 3);
  writeAddress(bytes, 32, 4);
  writeU64LE(bytes, 64, 55n);
  writeU32LE(bytes, 72, 1);
  writeAddress(bytes, 76, 5);
  bytes[108] = TokenAccountState.Frozen;
  writeU32LE(bytes, 109, 1);
  writeU64LE(bytes, 113, 88n);
  writeU64LE(bytes, 121, 13n);
  writeU32LE(bytes, 129, 1);
  writeAddress(bytes, 133, 6);
  return bytes;
};

const writeStopLoss = (
  bytes: Uint8Array,
  offset: number,
  config: {
    sequenceNumber: bigint;
    triggerPrice: bigint;
    executionPrice: bigint;
    tradeSize: bigint;
    slot: bigint;
    positionSequenceNumber: number;
    flags: number;
  }
): void => {
  writeU64LE(bytes, offset, config.sequenceNumber);
  writeU64LE(bytes, offset + 8, config.triggerPrice);
  writeU64LE(bytes, offset + 16, config.executionPrice);
  writeU64LE(bytes, offset + 24, config.tradeSize);
  writeU64LE(bytes, offset + 32, config.slot);
  bytes[offset + 40] = config.positionSequenceNumber;
  bytes[offset + 41] = config.flags;
};

const createStopLossesBytes = (): Uint8Array => {
  const bytes = new Uint8Array(328);
  bytes.set(ACCOUNT_DISCRIMINANTS.STOP_LOSSES, 0);

  writeStopLoss(bytes, 8, {
    sequenceNumber: 11n,
    triggerPrice: 101n,
    executionPrice: 111n,
    tradeSize: 7n,
    slot: 500n,
    positionSequenceNumber: 4,
    flags: 0x0f,
  });

  writeStopLoss(bytes, 88, {
    sequenceNumber: 12n,
    triggerPrice: 202n,
    executionPrice: 0n,
    tradeSize: 9n,
    slot: 600n,
    positionSequenceNumber: 5,
    flags: 0x00,
  });

  writeU64LE(bytes, 168, 1n);
  writeU64LE(bytes, 176, 91n);
  writeU64LE(bytes, 184, 92n);
  writeAddress(bytes, 192, 17);
  writeAddress(bytes, 224, 18);
  writeU64LE(bytes, 256, 19n);

  return bytes;
};

const createWithdrawQueueHeaderBytes = (): Uint8Array => {
  const bytes = new Uint8Array(120);
  bytes.set(ACCOUNT_DISCRIMINANTS.WITHDRAW_QUEUE_HEADER, 0);
  writeU64LE(bytes, 8, 201n);
  writeU64LE(bytes, 16, 202n);
  writeU64LE(bytes, 24, 1_000n);
  writeU64LE(bytes, 32, 900n);
  writeU64LE(bytes, 40, 50n);
  writeU64LE(bytes, 48, 203n);
  writeU64LE(bytes, 56, 777n);
  writeU64LE(bytes, 64, 12n);
  writeU64LE(bytes, 72, 3n);
  return bytes;
};

const loadMockBytes = (fileName: string): Uint8Array => {
  const fixture = JSON.parse(
    readFileSync(resolve(MOCKS_DIR, fileName), "utf8")
  ) as FixtureFile;
  return Buffer.from(fixture.account.data[0], "base64");
};

const normalize = (value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalize(nested),
      ])
    );
  }

  return value;
};

const expectDecodedMockToMatchSnapshot = <T>(
  fileName: string,
  decode: (bytes: Uint8Array) => T
): void => {
  expect(normalize(decode(loadMockBytes(fileName)))).toMatchSnapshot();
};

describe("raw account parsing", () => {
  it("decodes GlobalConfiguration fixtures", () => {
    expectDecodedMockToMatchSnapshot(
      "global_config.json",
      decodeGlobalConfiguration
    );
  });

  it("decodes PerpAssetMap fixtures", () => {
    expectDecodedMockToMatchSnapshot("perp_asset_map.json", decodePerpAssetMap);
  });

  it("decodes Trader fixtures", () => {
    expectDecodedMockToMatchSnapshot("trader.json", decodeTrader);
  });

  it("decodes Orderbook fixtures", () => {
    expectDecodedMockToMatchSnapshot("orderbook.json", decodeOrderbook);
  });

  it("decodes SplineCollection fixtures", () => {
    expectDecodedMockToMatchSnapshot("splines.json", decodeSplineCollection);
  });

  it("decodes OrderbookHeader from the orderbook account prefix", () => {
    const bytes = loadMockBytes("orderbook.json");

    expect(normalize(decodeOrderbookHeader(bytes))).toEqual(
      normalize(decodeOrderbook(bytes).header)
    );
  });

  it("decodes Mint accounts", () => {
    expect(decodeMint(createMintBytes())).toEqual({
      mintAuthorityOption: 1,
      mintAuthority: addressFromFill(7),
      supply: 1_234_567n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 1,
      freezeAuthority: addressFromFill(9),
    });
  });

  it("decodes TokenAccount accounts", () => {
    expect(decodeTokenAccount(createTokenAccountBytes())).toEqual({
      mint: addressFromFill(3),
      owner: addressFromFill(4),
      amount: 55n,
      delegateOption: 1,
      delegate: addressFromFill(5),
      state: TokenAccountState.Frozen,
      isNativeOption: 1,
      isNative: 88n,
      delegatedAmount: 13n,
      closeAuthorityOption: 1,
      closeAuthority: addressFromFill(6),
    });
  });

  it("decodes StopLosses accounts", () => {
    expect(decodeStopLosses(createStopLossesBytes())).toEqual({
      stopLosses: [
        {
          sequenceNumber: 11n,
          triggerPrice: 101n,
          executionPrice: 111n,
          tradeSize: 7n,
          slot: 500n,
          positionSequenceNumber: 4,
          isActive: true,
          executionDirection: Direction.GreaterThan,
          tradeSide: Side.Bid,
          orderKind: StopLossOrderKind.Limit,
        },
        {
          sequenceNumber: 12n,
          triggerPrice: 202n,
          executionPrice: 0n,
          tradeSize: 9n,
          slot: 600n,
          positionSequenceNumber: 5,
          isActive: false,
          executionDirection: Direction.LessThan,
          tradeSide: Side.Ask,
          orderKind: StopLossOrderKind.IOC,
        },
      ],
      isInitialized: true,
      sequenceNumber: {
        sequenceNumber: 91n,
        lastUpdateSlot: 92n,
      },
      fundingKey: addressFromFill(17),
      traderKey: addressFromFill(18),
      assetId: 19n,
    });
  });

  it("decodes WithdrawQueueHeader accounts", () => {
    expect(decodeWithdrawQueueHeader(createWithdrawQueueHeaderBytes())).toEqual(
      {
        sequenceNumber: {
          sequenceNumber: 201n,
          lastUpdateSlot: 202n,
        },
        withdrawThrottle: {
          maxBudget: 1_000n,
          remainingBudget: 900n,
          replenishAmountPerSlot: 50n,
          lastUpdateSlot: 203n,
        },
        totalQueuedAmount: 777n,
        withdrawalFee: 12n,
        enqueuingFee: 3n,
      }
    );
  });
});
