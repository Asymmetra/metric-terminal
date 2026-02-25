from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .candles import ApiCandle
from .core import JsSafeU64, PhoenixModel, Side


class Timeframe(str, Enum):
    SECOND_1 = "1s"
    SECOND_5 = "5s"
    MINUTE_1 = "1m"
    MINUTE_5 = "5m"
    MINUTE_15 = "15m"
    MINUTE_30 = "30m"
    HOUR_1 = "1h"
    HOUR_4 = "4h"
    DAY_1 = "1d"


class AllMidsData(PhoenixModel):
    mids: dict[str, float]
    slot: int
    slot_index: int


class FundingRateMessage(PhoenixModel):
    symbol: str
    cumulative_funding_rate: int
    previous_settled_funding_rate: int
    funding_start_interval_timestamp: int


class L2Orderbook(PhoenixModel):
    bids: list[tuple[float, float]]
    asks: list[tuple[float, float]]
    mid: float | None = None


class L2BookUpdate(PhoenixModel):
    symbol: str
    orderbook: L2Orderbook


class MarketStatsUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    symbol: str
    open_interest: float = Field(alias="openInterest")
    mark_price: float = Field(alias="markPx")
    mid_price: float = Field(alias="midPx")
    oracle_price: float = Field(alias="oraclePx")
    prev_day_mark_price: float = Field(alias="prevDayPx")
    day_volume_usd: float = Field(alias="dayNtlVlm")
    funding_rate: float = Field(alias="funding")


class TradeEvent(PhoenixModel):
    slot: JsSafeU64
    slot_index: int
    timestamp: JsSafeU64
    symbol: str
    taker: str
    trade_sequence_number: JsSafeU64
    side: Side
    base_lots_filled: JsSafeU64
    quote_lots_filled: JsSafeU64
    fee_in_quote_lots: JsSafeU64
    base_amount: float
    quote_amount: float
    num_fills: int


class TradesMessage(PhoenixModel):
    symbol: str
    trades: list[TradeEvent]


class CandleData(PhoenixModel):
    candle: ApiCandle
    symbol: str
    timeframe: str


class TraderStateServerMessage(PhoenixModel):
    authority: str
    trader_pda_index: int
    slot: int
    message_type: str
    data: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_raw(cls, raw: dict[str, Any]) -> TraderStateServerMessage:
        """Parse from a raw JSON dict, extracting known fields and keeping the rest as data."""
        known = {"authority", "traderPdaIndex", "slot", "messageType", "channel"}
        data = {k: v for k, v in raw.items() if k not in known}
        return cls(
            authority=raw["authority"],
            trader_pda_index=raw["traderPdaIndex"],
            slot=raw["slot"],
            message_type=raw["messageType"],
            data=data,
        )
