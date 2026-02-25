from __future__ import annotations

from .core import PhoenixModel


class ApiCandle(PhoenixModel):
    time: int
    low: float
    high: float
    open: float
    close: float
    volume: float | None = None
    trade_count: int | None = None


class CandlesQueryParams:
    def __init__(self, symbol: str, timeframe: str) -> None:
        self.symbol = symbol
        self.timeframe = timeframe
        self.start_time: int | None = None
        self.end_time: int | None = None
        self.limit: int | None = None

    def with_start_time(self, start_time: int) -> CandlesQueryParams:
        self.start_time = start_time
        return self

    def with_end_time(self, end_time: int) -> CandlesQueryParams:
        self.end_time = end_time
        return self

    def with_limit(self, limit: int) -> CandlesQueryParams:
        self.limit = limit
        return self

    def to_params(self) -> dict[str, str | int]:
        params: dict[str, str | int] = {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
        }
        if self.start_time is not None:
            params["startTime"] = self.start_time
        if self.end_time is not None:
            params["endTime"] = self.end_time
        if self.limit is not None:
            params["limit"] = self.limit
        return params
