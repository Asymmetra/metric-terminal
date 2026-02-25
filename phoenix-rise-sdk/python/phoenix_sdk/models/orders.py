from __future__ import annotations

from datetime import datetime
from enum import Enum

from .core import PaginatedResponse, PhoenixModel, Side


class OrderStatus(str, Enum):
    OPEN = "open"
    FILLED = "filled"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class OrderHistoryItem(PhoenixModel):
    order_sequence_number: str
    market_symbol: str
    status: OrderStatus
    side: Side
    is_reduce_only: bool
    is_stop_loss: bool = False
    price: str
    base_qty: str
    remaining_base_qty: str
    filled_base_qty: str
    placed_at: datetime | None = None
    completed_at: datetime | None = None


OrderHistoryResponse = PaginatedResponse[list[OrderHistoryItem]]


class OrderHistoryQueryParams:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.trader_pda_index: int | None = None
        self.market_symbol: str | None = None
        self.cursor: str | None = None
        self.privy_id: str | None = None

    def with_pda_index(self, pda_index: int) -> OrderHistoryQueryParams:
        self.trader_pda_index = pda_index
        return self

    def with_market_symbol(self, market_symbol: str) -> OrderHistoryQueryParams:
        self.market_symbol = market_symbol
        return self

    def with_cursor(self, cursor: str) -> OrderHistoryQueryParams:
        self.cursor = cursor
        return self

    def with_privy_id(self, privy_id: str) -> OrderHistoryQueryParams:
        self.privy_id = privy_id
        return self

    def to_params(self) -> dict[str, str | int]:
        params: dict[str, str | int] = {"limit": self.limit}
        if self.trader_pda_index is not None:
            params["traderPdaIndex"] = self.trader_pda_index
        if self.market_symbol is not None:
            params["marketSymbol"] = self.market_symbol
        if self.cursor is not None:
            params["cursor"] = self.cursor
        if self.privy_id is not None:
            params["privyId"] = self.privy_id
        return params
