export interface Market {
  symbol: string;
  status: string;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookData {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  symbol: string;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketStats {
  mark_price: number;
  index_price: number;
  last_price: number;
  volume_24h: number;
  funding_rate: number;
  open_interest: number;
}

export interface Trade {
  price: number;
  size: number;
  side: "bid" | "ask";
  timestamp: number | string;
}
