from __future__ import annotations

from datetime import datetime

from .core import PhoenixModel


class CollateralEvent(PhoenixModel):
    slot: int
    slot_index: int
    event_index: int
    trader_pda_index: int
    trader_subaccount_index: int
    event_type: str
    amount: int
    collateral_after: int
    timestamp: datetime


class CollateralHistoryResponse(PhoenixModel):
    data: list[CollateralEvent]
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool


class CollateralHistoryQueryParams:
    def __init__(self, limit: int) -> None:
        self.pda_index: int = 0
        self.limit = limit
        self.next_cursor: str | None = None
        self.prev_cursor: str | None = None
        self.cursor: str | None = None

    def with_pda_index(self, pda_index: int) -> CollateralHistoryQueryParams:
        self.pda_index = pda_index
        return self

    def with_next_cursor(self, cursor: str) -> CollateralHistoryQueryParams:
        self.next_cursor = cursor
        return self

    def with_prev_cursor(self, cursor: str) -> CollateralHistoryQueryParams:
        self.prev_cursor = cursor
        return self

    def with_cursor(self, cursor: str) -> CollateralHistoryQueryParams:
        self.cursor = cursor
        return self

    def to_params(self) -> dict[str, str | int]:
        params: dict[str, str | int] = {
            "pdaIndex": self.pda_index,
            "limit": self.limit,
        }
        if self.next_cursor is not None:
            params["nextCursor"] = self.next_cursor
        if self.prev_cursor is not None:
            params["prevCursor"] = self.prev_cursor
        if self.cursor is not None:
            params["cursor"] = self.cursor
        return params
