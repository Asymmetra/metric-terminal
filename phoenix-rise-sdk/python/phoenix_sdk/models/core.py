from __future__ import annotations

from enum import Enum
from typing import Annotated, Generic, TypeVar

from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic.alias_generators import to_camel

T = TypeVar("T")


class PhoenixModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


def _parse_js_safe_u64(v: int | str) -> int:
    return int(v)


JsSafeU64 = Annotated[int, BeforeValidator(_parse_js_safe_u64)]


class Decimal(PhoenixModel):
    value: int
    decimals: int
    ui: str


class Price(PhoenixModel):
    price: float
    slot: int


class Side(str, Enum):
    BID = "bid"
    ASK = "ask"


class PaginatedResponse(PhoenixModel, Generic[T]):
    data: T
    prev_cursor: str | None = None
    next_cursor: str | None = None
    has_more: bool
