import z from "zod";

interface WSCandle {
  time: number;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
  volumeQuote?: number;
  tradeCount: number;
}

export interface CandleUpdate {
  candle: WSCandle;
  symbol: string;
  timeframe: string;
}

export interface CandleMsg {
  channel: "candle";
  candle: WSCandle;
  symbol: string;
  timeframe: string;
}

const candlePayloadSchema = z.object({
  time: z.number().int(),
  low: z.number(),
  high: z.number(),
  open: z.number(),
  close: z.number(),
  volume: z.number(),
  volumeQuote: z.number().optional(),
  tradeCount: z.number().int(),
});

export const CandleUpdateSchema: z.ZodType<CandleUpdate> = z.object({
  candle: candlePayloadSchema,
  symbol: z.string(),
  timeframe: z.string(),
});

export const CandleMsgSchema: z.ZodType<CandleMsg> = z.object({
  channel: z.literal("candle"),
  candle: candlePayloadSchema,
  symbol: z.string(),
  timeframe: z.string(),
});
