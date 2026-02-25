from __future__ import annotations

from .core import PhoenixModel


class FundingHistoryEvent(PhoenixModel):
    timestamp: int
    symbol: str
    funding_payment: str
    funding_rate_percentage: str
    position_size: str
    position_side: str


class FundingHistoryResponse(PhoenixModel):
    events: list[FundingHistoryEvent]
    prev_cursor: str | None = None
    next_cursor: str | None = None
    has_more: bool


class FundingHistoryQueryParams:
    def __init__(self) -> None:
        self.pda_index: int = 0
        self.symbol: str | None = None
        self.start_time: int | None = None
        self.end_time: int | None = None
        self.limit: int | None = None
        self.cursor: str | None = None

    def with_pda_index(self, pda_index: int) -> FundingHistoryQueryParams:
        self.pda_index = pda_index
        return self

    def with_symbol(self, symbol: str) -> FundingHistoryQueryParams:
        self.symbol = symbol
        return self

    def with_start_time(self, start_time: int) -> FundingHistoryQueryParams:
        self.start_time = start_time
        return self

    def with_end_time(self, end_time: int) -> FundingHistoryQueryParams:
        self.end_time = end_time
        return self

    def with_limit(self, limit: int) -> FundingHistoryQueryParams:
        self.limit = limit
        return self

    def with_cursor(self, cursor: str) -> FundingHistoryQueryParams:
        self.cursor = cursor
        return self

    def to_params(self) -> dict[str, str | int]:
        params: dict[str, str | int] = {}
        if self.symbol is not None:
            params["symbol"] = self.symbol
        if self.start_time is not None:
            params["startTime"] = self.start_time
        if self.end_time is not None:
            params["endTime"] = self.end_time
        if self.limit is not None:
            params["limit"] = self.limit
        if self.cursor is not None:
            params["cursor"] = self.cursor
        return params
