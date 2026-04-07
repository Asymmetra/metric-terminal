import { DISCRIMINANTS } from "@/core/discriminants";
import {
  getBaseLotsPerTickDecoder,
  getBaseLotsPerTickEncoder,
  getTicksDecoder,
  getTicksEncoder,
  type BaseLotsPerTick,
  type Ticks,
} from "@/primitives";
import {
  combineCodec,
  getArrayDecoder,
  getArrayEncoder,
  getBooleanDecoder,
  getBooleanEncoder,
  getConstantDecoder,
  getConstantEncoder,
  getHiddenPrefixDecoder,
  getHiddenPrefixEncoder,
  getStructDecoder,
  getStructEncoder,
  type Codec,
  type Decoder,
  type Encoder,
} from "@solana/kit";

export interface TickRegionParams {
  startOffset: Ticks;
  endOffset: Ticks;
  density: BaseLotsPerTick;
}

export interface UpdateSplineParametersInstruction {
  bidRegions: TickRegionParams[];
  askRegions: TickRegionParams[];
  refreshRegions: boolean;
}

export const getTickRegionParamsEncoder = (): Encoder<TickRegionParams> =>
  getStructEncoder([
    ["startOffset", getTicksEncoder()],
    ["endOffset", getTicksEncoder()],
    ["density", getBaseLotsPerTickEncoder()],
  ]);

export const getTickRegionParamsDecoder = (): Decoder<TickRegionParams> =>
  getStructDecoder([
    ["startOffset", getTicksDecoder()],
    ["endOffset", getTicksDecoder()],
    ["density", getBaseLotsPerTickDecoder()],
  ]);

export const getTickRegionParamsCodec = (): Codec<TickRegionParams> =>
  combineCodec(getTickRegionParamsEncoder(), getTickRegionParamsDecoder());

export const getUpdateSplineParametersInstructionEncoder =
  (): Encoder<UpdateSplineParametersInstruction> =>
    getStructEncoder([
      ["bidRegions", getArrayEncoder(getTickRegionParamsEncoder())],
      ["askRegions", getArrayEncoder(getTickRegionParamsEncoder())],
      ["refreshRegions", getBooleanEncoder()],
    ]);

export const getUpdateSplineParametersInstructionDecoder =
  (): Decoder<UpdateSplineParametersInstruction> =>
    getStructDecoder([
      ["bidRegions", getArrayDecoder(getTickRegionParamsDecoder())],
      ["askRegions", getArrayDecoder(getTickRegionParamsDecoder())],
      ["refreshRegions", getBooleanDecoder()],
    ]);

export const getUpdateSplineParametersInstructionCodec =
  (): Codec<UpdateSplineParametersInstruction> =>
    combineCodec(
      getUpdateSplineParametersInstructionEncoder(),
      getUpdateSplineParametersInstructionDecoder()
    );

export const getUpdateSplineParametersEncoder =
  (): Encoder<UpdateSplineParametersInstruction> =>
    getHiddenPrefixEncoder(getUpdateSplineParametersInstructionEncoder(), [
      getConstantEncoder(DISCRIMINANTS.UPDATE_SPLINE_PARAMETERS),
    ]);

export const getUpdateSplineParametersDecoder =
  (): Decoder<UpdateSplineParametersInstruction> =>
    getHiddenPrefixDecoder(getUpdateSplineParametersInstructionDecoder(), [
      getConstantDecoder(DISCRIMINANTS.UPDATE_SPLINE_PARAMETERS),
    ]);

export const getUpdateSplineParametersCodec =
  (): Codec<UpdateSplineParametersInstruction> =>
    combineCodec(
      getUpdateSplineParametersEncoder(),
      getUpdateSplineParametersDecoder()
    );
