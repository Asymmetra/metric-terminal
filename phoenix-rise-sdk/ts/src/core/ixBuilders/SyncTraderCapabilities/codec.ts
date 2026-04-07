import { DISCRIMINANTS } from "@/core/discriminants";
import {
  combineCodec,
  fixDecoderSize,
  fixEncoderSize,
  getConstantDecoder,
  getConstantEncoder,
  type Codec,
  type Decoder,
  type Encoder,
} from "@solana/kit";

export const getSyncTraderCapabilitiesEncoder = (): Encoder<void> =>
  fixEncoderSize(getConstantEncoder(DISCRIMINANTS.SYNC_TRADER_CAPABILITIES), 8);

export const getSyncTraderCapabilitiesDecoder = (): Decoder<void> =>
  fixDecoderSize(getConstantDecoder(DISCRIMINANTS.SYNC_TRADER_CAPABILITIES), 8);

export const getSyncTraderCapabilitiesCodec = (): Codec<void> =>
  combineCodec(
    getSyncTraderCapabilitiesEncoder(),
    getSyncTraderCapabilitiesDecoder()
  );
