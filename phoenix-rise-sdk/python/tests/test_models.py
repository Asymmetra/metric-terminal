import json

from phoenix_sdk.models.candles import ApiCandle
from phoenix_sdk.models.collateral import CollateralEvent, CollateralHistoryResponse
from phoenix_sdk.models.core import Decimal, PaginatedResponse, Side
from phoenix_sdk.models.exchange import (
    ExchangeKeysView,
    ExchangeMarketConfig,
    ExchangeResponse,
)
from phoenix_sdk.models.funding import FundingHistoryEvent, FundingHistoryResponse
from phoenix_sdk.models.market import MarketStatus, RiskState, RiskTier
from phoenix_sdk.models.orders import OrderHistoryItem, OrderStatus
from phoenix_sdk.models.trader import (
    TraderActivityState,
    TraderStateResponse,
    TraderView,
)
from phoenix_sdk.models.trades import TradeHistoryItem


def test_decimal_from_json():
    data = {"value": 1000000, "decimals": 6, "ui": "1.000000"}
    d = Decimal.model_validate(data)
    assert d.value == 1000000
    assert d.decimals == 6
    assert d.ui == "1.000000"


def test_side_enum():
    assert Side.BID == "bid"
    assert Side.ASK == "ask"


def test_market_status_camel_case():
    assert MarketStatus.POST_ONLY == "postOnly"
    assert MarketStatus.ACTIVE == "active"


def test_risk_state_camel_case():
    assert RiskState.ZERO_COLLATERAL_NO_POSITIONS == "zeroCollateralNoPositions"


def test_risk_tier_camel_case():
    assert RiskTier.BACKSTOP_LIQUIDATABLE == "backstopLiquidatable"


def test_api_candle_from_json():
    data = {
        "time": 1700000000,
        "low": 100.5,
        "high": 105.0,
        "open": 101.0,
        "close": 104.0,
    }
    candle = ApiCandle.model_validate(data)
    assert candle.time == 1700000000
    assert candle.volume is None
    assert candle.trade_count is None


def test_api_candle_with_optional_fields():
    data = {
        "time": 1700000000,
        "low": 100.5,
        "high": 105.0,
        "open": 101.0,
        "close": 104.0,
        "volume": 50000.0,
        "tradeCount": 42,
    }
    candle = ApiCandle.model_validate(data)
    assert candle.volume == 50000.0
    assert candle.trade_count == 42


def test_exchange_market_config_camel_case():
    data = {
        "symbol": "SOL",
        "assetId": 1,
        "marketStatus": "active",
        "marketPubkey": "abc123",
        "splinePubkey": "def456",
        "tickSize": 100,
        "baseLotsDecimals": 3,
        "takerFee": 0.0005,
        "makerFee": -0.0002,
        "leverageTiers": [
            {
                "maxLeverage": 20.0,
                "maxSizeBaseLots": 1000000,
                "limitOrderRiskFactor": 0.05,
            }
        ],
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
        "openInterestCapBaseLots": "1000000000",
        "maxLiquidationSizeBaseLots": 500000,
        "isolatedOnly": False,
    }
    config = ExchangeMarketConfig.model_validate(data)
    assert config.symbol == "SOL"
    assert config.market_status == MarketStatus.ACTIVE
    assert config.taker_fee == 0.0005
    assert config.open_interest_cap_base_lots == 1000000000
    assert len(config.leverage_tiers) == 1
    assert config.leverage_tiers[0].max_leverage == 20.0


def test_js_safe_u64_from_string():
    data = {
        "symbol": "SOL",
        "assetId": 1,
        "marketStatus": "active",
        "marketPubkey": "abc",
        "splinePubkey": "def",
        "tickSize": 100,
        "baseLotsDecimals": 3,
        "takerFee": 0.0005,
        "makerFee": 0.0,
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
        "openInterestCapBaseLots": "9007199254740992",
        "maxLiquidationSizeBaseLots": "500000",
        "isolatedOnly": False,
    }
    config = ExchangeMarketConfig.model_validate(data)
    assert config.open_interest_cap_base_lots == 9007199254740992
    assert config.max_liquidation_size_base_lots == 500000


def test_funding_history_event_from_json():
    data = {
        "timestamp": 1700000000,
        "symbol": "SOL",
        "fundingPayment": "0.001234",
        "fundingRatePercentage": "0.01",
        "positionSize": "100.0",
        "positionSide": "long",
    }
    event = FundingHistoryEvent.model_validate(data)
    assert event.symbol == "SOL"
    assert event.funding_payment == "0.001234"


def test_funding_history_response_from_json():
    data = {
        "events": [],
        "hasMore": False,
    }
    resp = FundingHistoryResponse.model_validate(data)
    assert resp.events == []
    assert resp.has_more is False
    assert resp.next_cursor is None


def test_trade_history_item_from_json():
    data = {
        "marketSymbol": "SOL",
        "baseQty": "10.5",
        "quoteQty": "1050.0",
        "price": "100.0",
        "timestamp": "2024-01-01T00:00:00Z",
        "transactionSignature": "abc123",
        "instructionType": "marketOrder",
    }
    item = TradeHistoryItem.model_validate(data)
    assert item.market_symbol == "SOL"
    assert item.base_qty == "10.5"


def test_order_history_item_from_json():
    data = {
        "orderSequenceNumber": "12345",
        "marketSymbol": "SOL",
        "status": "open",
        "side": "bid",
        "isReduceOnly": False,
        "price": "100.0",
        "baseQty": "10.0",
        "remainingBaseQty": "10.0",
        "filledBaseQty": "0.0",
    }
    item = OrderHistoryItem.model_validate(data)
    assert item.status == OrderStatus.OPEN
    assert item.side == Side.BID
    assert item.is_stop_loss is False
    assert item.placed_at is None


def test_collateral_history_response_from_json():
    data = {
        "data": [
            {
                "slot": 100,
                "slotIndex": 0,
                "eventIndex": 0,
                "traderPdaIndex": 0,
                "traderSubaccountIndex": 0,
                "eventType": "deposit",
                "amount": 1000000,
                "collateralAfter": 1000000,
                "timestamp": "2024-01-01T00:00:00Z",
            }
        ],
        "hasMore": False,
    }
    resp = CollateralHistoryResponse.model_validate(data)
    assert len(resp.data) == 1
    assert resp.data[0].event_type == "deposit"
    assert resp.has_more is False
