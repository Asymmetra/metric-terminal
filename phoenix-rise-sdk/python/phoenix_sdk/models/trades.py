from __future__ import annotations

from .core import PaginatedResponse, PhoenixModel


class TradeHistoryItem(PhoenixModel):
    market_symbol: str
    base_qty: str
    quote_qty: str
    price: str
    timestamp: str
    transaction_signature: str
    instruction_type: str


TradeHistoryResponse = PaginatedResponse[list[TradeHistoryItem]]


class TradeHistoryQueryParams:
    def __init__(self) -> None:
        self.pda_index: int = 0
        self.market_symbol: str | None = None
        self.limit: int | None = None
        self.cursor: str | None = None

    def with_pda_index(self, pda_index: int) -> TradeHistoryQueryParams:
        self.pda_index = pda_index
        return self

    def with_market_symbol(self, market_symbol: str) -> TradeHistoryQueryParams:
        self.market_symbol = market_symbol
        return self

    def with_limit(self, limit: int) -> TradeHistoryQueryParams:
        self.limit = limit
        return self

    def with_cursor(self, cursor: str) -> TradeHistoryQueryParams:
        self.cursor = cursor
        return self

    def to_params(self) -> dict[str, str | int]:
        params: dict[str, str | int] = {"pdaIndex": self.pda_index}
        if self.market_symbol is not None:
            params["market_symbol"] = self.market_symbol
        if self.limit is not None:
            params["limit"] = self.limit
        if self.cursor is not None:
            params["cursor"] = self.cursor
        return params
