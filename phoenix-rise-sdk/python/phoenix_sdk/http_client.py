from __future__ import annotations

from typing import TypeVar

import httpx
from pydantic import BaseModel, TypeAdapter

from .config import PhoenixEnv
from .errors import ApiError, ParseFailed, RequestFailed
from .models.candles import ApiCandle, CandlesQueryParams
from .models.collateral import (
    CollateralHistoryQueryParams,
    CollateralHistoryResponse,
)
from .models.exchange import (
    ExchangeKeysView,
    ExchangeMarketConfig,
    ExchangeResponse,
)
from .models.funding import FundingHistoryQueryParams, FundingHistoryResponse
from .models.orders import OrderHistoryQueryParams, OrderHistoryResponse
from .models.trader import TraderStateResponse, TraderView
from .models.trades import TradeHistoryQueryParams, TradeHistoryResponse

T = TypeVar("T", bound=BaseModel)

API_KEY_HEADER = "x-api-key"


class PhoenixHttpClient:
    """HTTP client for Phoenix API.

    Provides methods for fetching exchange configuration and market data
    from the Phoenix perpetuals API.
    """

    def __init__(self, api_url: str, api_key: str | None = None) -> None:
        self._api_url = api_url.rstrip("/")
        self._api_key = api_key
        self._client = httpx.AsyncClient()

    @classmethod
    def from_env(cls, env: PhoenixEnv | None = None) -> PhoenixHttpClient:
        if env is None:
            env = PhoenixEnv.load()
        return cls(api_url=env.api_url, api_key=env.api_key)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> PhoenixHttpClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    def _headers(self) -> dict[str, str]:
        if self._api_key is not None:
            return {API_KEY_HEADER: self._api_key}
        return {}

    async def _get(
        self,
        path: str,
        response_type: type[T],
        params: dict[str, str | int] | None = None,
    ) -> T:
        url = f"{self._api_url}{path}"
        try:
            response = await self._client.get(
                url, headers=self._headers(), params=params
            )
        except httpx.HTTPError as e:
            raise RequestFailed(str(e)) from e

        if not response.is_success:
            raise ApiError(response.status_code, response.text)

        try:
            return response_type.model_validate_json(response.content)
        except Exception as e:
            raise ParseFailed(
                f"Failed to parse {response_type.__name__}: {e}",
                body=response.text,
            ) from e

    async def _get_list(
        self,
        path: str,
        item_type: type[T],
        params: dict[str, str | int] | None = None,
    ) -> list[T]:
        url = f"{self._api_url}{path}"
        try:
            response = await self._client.get(
                url, headers=self._headers(), params=params
            )
        except httpx.HTTPError as e:
            raise RequestFailed(str(e)) from e

        if not response.is_success:
            raise ApiError(response.status_code, response.text)

        try:
            adapter = TypeAdapter(list[item_type])
            return adapter.validate_json(response.content)
        except Exception as e:
            raise ParseFailed(
                f"Failed to parse list[{item_type.__name__}]: {e}",
                body=response.text,
            ) from e

    async def get_exchange_keys(self) -> ExchangeKeysView:
        return await self._get("/exchange/keys", ExchangeKeysView)

    async def get_markets(self) -> list[ExchangeMarketConfig]:
        return await self._get_list("/exchange/markets", ExchangeMarketConfig)

    async def get_market(self, symbol: str) -> ExchangeMarketConfig:
        return await self._get(
            f"/exchange/market/{symbol.upper()}", ExchangeMarketConfig
        )

    async def get_exchange(self) -> ExchangeResponse:
        return await self._get("/exchange", ExchangeResponse)

    async def get_traders(
        self, authority: str, pda_index: int = 0
    ) -> list[TraderView]:
        resp = await self._get(
            f"/trader/{authority}/state",
            TraderStateResponse,
            params={"pdaIndex": pda_index},
        )
        return resp.traders

    async def get_collateral_history(
        self,
        authority: str,
        params: CollateralHistoryQueryParams,
    ) -> CollateralHistoryResponse:
        return await self._get(
            f"/trader/{authority}/collateral-history",
            CollateralHistoryResponse,
            params=params.to_params(),
        )

    async def get_funding_history(
        self,
        authority: str,
        params: FundingHistoryQueryParams,
    ) -> FundingHistoryResponse:
        return await self._get(
            f"/trader/{authority}/funding-history",
            FundingHistoryResponse,
            params=params.to_params(),
        )

    async def get_order_history(
        self,
        authority: str,
        params: OrderHistoryQueryParams,
    ) -> OrderHistoryResponse:
        return await self._get(
            f"/trader/{authority}/order-history",
            OrderHistoryResponse,
            params=params.to_params(),
        )

    async def get_trade_history(
        self,
        authority: str,
        params: TradeHistoryQueryParams,
    ) -> TradeHistoryResponse:
        return await self._get(
            f"/trader/{authority}/trades-history",
            TradeHistoryResponse,
            params=params.to_params(),
        )

    async def get_candles(self, params: CandlesQueryParams) -> list[ApiCandle]:
        return await self._get_list(
            "/candles", ApiCandle, params=params.to_params()
        )
