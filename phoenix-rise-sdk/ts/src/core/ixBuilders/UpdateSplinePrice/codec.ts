import { DISCRIMINANTS } from "@/core/discriminants";
import { getOptionToNullDecoder, getOptionToNullEncoder } from "@/core/utils";
import {
  combineCodec,
  getBooleanDecoder,
  getBooleanEncoder,
  getConstantDecoder,
  getConstantEncoder,
  getHiddenPrefixDecoder,
  getHiddenPrefixEncoder,
  getStructDecoder,
  getStructEncoder,
  getU64Decoder,
  getU64Encoder,
  type Codec,
  type Decoder,
  type Encoder,
} from "@solana/kit";

export interface UpdateSplinePriceInstruction {
  newMidPrice: bigint;
  userUpdateSlot: bigint | null;
  refreshRegions: boolean;
}

export const getUpdateSplinePriceInstructionEncoder =
  (): Encoder<UpdateSplinePriceInstruction> =>
    getStructEncoder([
      ["newMidPrice", getU64Encoder()],
      ["userUpdateSlot", getOptionToNullEncoder(getU64Encoder())],
      ["refreshRegions", getBooleanEncoder()],
    ]);

export const getUpdateSplinePriceInstructionDecoder =
  (): Decoder<UpdateSplinePriceInstruction> =>
    getStructDecoder([
      ["newMidPrice", getU64Decoder()],
      ["userUpdateSlot", getOptionToNullDecoder(getU64Decoder())],
      ["refreshRegions", getBooleanDecoder()],
    ]);

export const getUpdateSplinePriceInstructionCodec =
  (): Codec<UpdateSplinePriceInstruction> =>
    combineCodec(
      getUpdateSplinePriceInstructionEncoder(),
      getUpdateSplinePriceInstructionDecoder()
    );

export const getUpdateSplinePriceEncoder =
  (): Encoder<UpdateSplinePriceInstruction> =>
    getHiddenPrefixEncoder(getUpdateSplinePriceInstructionEncoder(), [
      getConstantEncoder(DISCRIMINANTS.UPDATE_SPLINE_PRICE),
    ]);

export const getUpdateSplinePriceDecoder =
  (): Decoder<UpdateSplinePriceInstruction> =>
    getHiddenPrefixDecoder(getUpdateSplinePriceInstructionDecoder(), [
      getConstantDecoder(DISCRIMINANTS.UPDATE_SPLINE_PRICE),
    ]);

export const getUpdateSplinePriceCodec =
  (): Codec<UpdateSplinePriceInstruction> =>
    combineCodec(getUpdateSplinePriceEncoder(), getUpdateSplinePriceDecoder());
