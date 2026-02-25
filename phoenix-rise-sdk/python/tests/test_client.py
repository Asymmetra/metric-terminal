import json

import httpx
import pytest
import respx

from phoenix_sdk import (
    ApiError,
    CandlesQueryParams,
    CollateralHistoryQueryParams,
    FundingHistoryQueryParams,
    OrderHistoryQueryParams,
    PhoenixHttpClient,
    RequestFailed,
    TradeHistoryQueryParams,
)

BASE_URL = "https://api.test.com"


@pytest.fixture
def client():
    return PhoenixHttpClient(BASE_URL, "test-key")


def _exchange_keys_json():
    return {
        "globalConfig": "gc1",
        "currentAuthorities": {
            "rootAuthority": "r1",
            "riskAuthority": "r2",
            "marketAuthority": "m1",
            "oracleAuthority": "o1",
        },
        "pendingAuthorities": {
            "rootAuthority": "r3",
            "riskAuthority": "r4",
            "marketAuthority": "m2",
            "oracleAuthority": "o2",
        },
        "canonicalMint": "mint1",
        "globalVault": "vault1",
        "perpAssetMap": "pam1",
        "globalTraderIndex": ["gti1"],
        "activeTraderBuffer": ["atb1"],
        "withdrawQueue": "wq1",
    }


def _market_config_json():
    return {
        "symbol": "SOL",
        "assetId": 1,
        "marketStatus": "active",
        "marketPubkey": "mp1",
        "splinePubkey": "sp1",
        "tickSize": 100,
        "baseLotsDecimals": 3,
        "takerFee": 0.0005,
        "makerFee": -0.0002,
        "leverageTiers": [],
        "riskFactors": {
            "maintenance": 0.03,
            "backstop": 0.01,
            "highRisk": 0.05,
            "upnl": 0.8,
            "upnlForWithdrawals": 0.6,
            "cancelOrder": 0.04,
        },
        "fundingIntervalSeconds": 3600,
        "fundingPeriodSeconds": 28800,
        "maxFundingRatePerInterval": 0.001,
        "openInterestCapBaseLots": 1000000,
        "maxLiquidationSizeBaseLots": 500000,
        "isolatedOnly": False,
    }


@respx.mock
@pytest.mark.asyncio
async def test_get_exchange_keys(client):
    respx.get(f"{BASE_URL}/exchange/keys").mock(
        return_value=httpx.Response(200, json=_exchange_keys_json())
    )
    keys = await client.get_exchange_keys()
    assert keys.global_config == "gc1"
    assert keys.current_authorities.root_authority == "r1"


@respx.mock
@pytest.mark.asyncio
async def test_get_markets(client):
    respx.get(f"{BASE_URL}/exchange/markets").mock(
        return_value=httpx.Response(200, json=[_market_config_json()])
    )
    markets = await client.get_markets()
    assert len(markets) == 1
    assert markets[0].symbol == "SOL"


@respx.mock
@pytest.mark.asyncio
async def test_get_market_uppercase(client):
    respx.get(f"{BASE_URL}/exchange/market/SOL").mock(
        return_value=httpx.Response(200, json=_market_config_json())
    )
    market = await client.get_market("sol")
    assert market.symbol == "SOL"


@respx.mock
@pytest.mark.asyncio
async def test_get_exchange(client):
    data = {"keys": _exchange_keys_json(), "markets": [_market_config_json()]}
    respx.get(f"{BASE_URL}/exchange").mock(
        return_value=httpx.Response(200, json=data)
    )
    exchange = await client.get_exchange()
    assert exchange.keys.global_config == "gc1"
    assert len(exchange.markets) == 1


@respx.mock
@pytest.mark.asyncio
async def test_get_traders(client):
    data = {
        "slot": 100,
        "slotIndex": 0,
        "authority": "auth1",
        "pdaIndex": 0,
        "traders": [],
    }
    respx.get(f"{BASE_URL}/trader/auth1/state").mock(
        return_value=httpx.Response(200, json=data)
    )
    traders = await client.get_traders("auth1")
    assert traders == []


@respx.mock
@pytest.mark.asyncio
async def test_get_candles(client):
    candles = [
        {"time": 1700000000, "low": 100.0, "high": 105.0, "open": 101.0, "close": 104.0}
    ]
    respx.get(f"{BASE_URL}/candles").mock(
        return_value=httpx.Response(200, json=candles)
    )
    params = CandlesQueryParams("SOL", "1m").with_limit(100)
    result = await client.get_candles(params)
    assert len(result) == 1
    assert result[0].close == 104.0


@respx.mock
@pytest.mark.asyncio
async def test_api_error(client):
    respx.get(f"{BASE_URL}/exchange/keys").mock(
        return_value=httpx.Response(404, text="Not found")
    )
    with pytest.raises(ApiError) as exc_info:
        await client.get_exchange_keys()
    assert exc_info.value.status == 404


@respx.mock
@pytest.mark.asyncio
async def test_api_key_header(client):
    route = respx.get(f"{BASE_URL}/exchange/keys").mock(
        return_value=httpx.Response(200, json=_exchange_keys_json())
    )
    await client.get_exchange_keys()
    assert route.calls[0].request.headers["x-api-key"] == "test-key"


@respx.mock
@pytest.mark.asyncio
async def test_no_api_key_header():
    public_client = PhoenixHttpClient(BASE_URL)
    route = respx.get(f"{BASE_URL}/exchange/keys").mock(
        return_value=httpx.Response(200, json=_exchange_keys_json())
    )
    await public_client.get_exchange_keys()
    assert "x-api-key" not in route.calls[0].request.headers


@respx.mock
@pytest.mark.asyncio
async def test_get_collateral_history(client):
    data = {
        "data": [],
        "hasMore": False,
    }
    respx.get(f"{BASE_URL}/trader/auth1/collateral-history").mock(
        return_value=httpx.Response(200, json=data)
    )
    params = CollateralHistoryQueryParams(100)
    resp = await client.get_collateral_history("auth1", params)
    assert resp.data == []
    assert resp.has_more is False


@respx.mock
@pytest.mark.asyncio
async def test_get_funding_history(client):
    data = {"events": [], "hasMore": False}
    respx.get(f"{BASE_URL}/trader/auth1/funding-history").mock(
        return_value=httpx.Response(200, json=data)
    )
    params = FundingHistoryQueryParams().with_symbol("SOL").with_limit(50)
    resp = await client.get_funding_history("auth1", params)
    assert resp.events == []


@respx.mock
@pytest.mark.asyncio
async def test_get_order_history(client):
    data = {"data": [], "hasMore": False}
    respx.get(f"{BASE_URL}/trader/auth1/order-history").mock(
        return_value=httpx.Response(200, json=data)
    )
    params = OrderHistoryQueryParams(100)
    resp = await client.get_order_history("auth1", params)
    assert resp.data == []


@respx.mock
@pytest.mark.asyncio
async def test_get_trade_history(client):
    data = {"data": [], "hasMore": False}
    respx.get(f"{BASE_URL}/trader/auth1/trades-history").mock(
        return_value=httpx.Response(200, json=data)
    )
    params = TradeHistoryQueryParams().with_limit(50)
    resp = await client.get_trade_history("auth1", params)
    assert resp.data == []
