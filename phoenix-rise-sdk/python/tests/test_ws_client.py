import asyncio
import json

import pytest

from phoenix_sdk.config import PhoenixEnv, _derive_ws_url
from phoenix_sdk.models.ws import (
    AllMidsData,
    CandleData,
    FundingRateMessage,
    L2BookUpdate,
    MarketStatsUpdate,
    Timeframe,
    TradeEvent,
    TraderStateServerMessage,
    TradesMessage,
)
from phoenix_sdk.ws_client import (
    PhoenixWSClient,
    WsConnectionStatus,
    _build_subscription_payload,
    _key_all_mids,
    _key_candles,
    _key_funding_rate,
    _key_market,
    _key_orderbook,
    _key_trader_state,
    _key_trades,
)


# ---------------------------------------------------------------------------
# WS URL derivation
# ---------------------------------------------------------------------------


class TestWsUrlDerivation:
    def test_https_to_wss(self):
        assert _derive_ws_url("https://api.phoenix.trade") == "wss://api.phoenix.trade/ws"

    def test_http_to_ws(self):
        assert _derive_ws_url("http://localhost:8080") == "ws://localhost:8080/ws"

    def test_trailing_slash(self):
        assert _derive_ws_url("https://api.phoenix.trade/") == "wss://api.phoenix.trade/ws"

    def test_existing_ws_path(self):
        assert (
            _derive_ws_url("https://api.phoenix.trade/ws")
            == "wss://api.phoenix.trade/ws"
        )

    def test_with_subpath(self):
        assert (
            _derive_ws_url("https://api.phoenix.trade/v1")
            == "wss://api.phoenix.trade/v1/ws"
        )

    def test_env_ws_url_field(self):
        env = PhoenixEnv(api_url="https://api.test.com", api_key=None)
        assert env.ws_url == "wss://api.test.com/ws"

    def test_env_explicit_ws_url(self):
        env = PhoenixEnv(
            api_url="https://api.test.com",
            api_key=None,
            ws_url="wss://custom.test.com/ws",
        )
        assert env.ws_url == "wss://custom.test.com/ws"

    def test_env_load_defaults(self, monkeypatch):
        monkeypatch.delenv("PHOENIX_API_URL", raising=False)
        monkeypatch.delenv("PHOENIX_WS_URL", raising=False)
        monkeypatch.delenv("PHOENIX_API_KEY", raising=False)
        env = PhoenixEnv.load()
        assert env.ws_url == "wss://public-api.phoenix.trade/ws"

    def test_env_load_ws_override(self, monkeypatch):
        monkeypatch.setenv("PHOENIX_WS_URL", "wss://override.test.com/ws")
        monkeypatch.delenv("PHOENIX_API_URL", raising=False)
        monkeypatch.delenv("PHOENIX_API_KEY", raising=False)
        env = PhoenixEnv.load()
        assert env.ws_url == "wss://override.test.com/ws"


# ---------------------------------------------------------------------------
# Subscription key helpers
# ---------------------------------------------------------------------------


class TestSubscriptionKeys:
    def test_build_all_mids_payload(self):
        key = _key_all_mids()
        payload = _build_subscription_payload(key)
        assert payload == {"channel": "allMids"}

    def test_build_orderbook_payload(self):
        key = _key_orderbook("SOL")
        payload = _build_subscription_payload(key)
        assert payload == {"channel": "orderbook", "symbol": "SOL"}

    def test_build_trader_state_payload(self):
        key = _key_trader_state("ABC123", 0)
        payload = _build_subscription_payload(key)
        assert payload == {
            "channel": "traderState",
            "authority": "ABC123",
            "traderPdaIndex": 0,
        }

    def test_build_candles_payload(self):
        key = _key_candles("SOL", "1m")
        payload = _build_subscription_payload(key)
        assert payload == {"channel": "candles", "symbol": "SOL", "timeframe": "1m"}


# ---------------------------------------------------------------------------
# Model parsing
# ---------------------------------------------------------------------------


class TestModelParsing:
    def test_all_mids(self):
        data = {"mids": {"SOL": 150.5, "BTC": 65000.0}, "slot": 100, "slotIndex": 0}
        msg = AllMidsData.model_validate(data)
        assert msg.mids["SOL"] == 150.5
        assert msg.slot == 100
        assert msg.slot_index == 0

    def test_funding_rate(self):
        data = {
            "symbol": "SOL",
            "cumulativeFundingRate": 12345,
            "previousSettledFundingRate": 100,
            "fundingStartIntervalTimestamp": 1700000000,
        }
        msg = FundingRateMessage.model_validate(data)
        assert msg.symbol == "SOL"
        assert msg.cumulative_funding_rate == 12345

    def test_l2_book_update(self):
        data = {
            "symbol": "SOL",
            "orderbook": {
                "bids": [[150.25, 100.0], [150.20, 200.0]],
                "asks": [[150.30, 150.0]],
                "mid": 150.275,
            },
        }
        msg = L2BookUpdate.model_validate(data)
        assert msg.symbol == "SOL"
        assert len(msg.orderbook.bids) == 2
        assert msg.orderbook.mid == 150.275

    def test_market_stats_update(self):
        data = {
            "symbol": "SOL",
            "openInterest": 367.51,
            "markPx": 97.35,
            "midPx": 97.315,
            "oraclePx": 97.4,
            "prevDayPx": 104.14,
            "dayNtlVlm": 243491.15,
            "funding": -0.00015,
        }
        msg = MarketStatsUpdate.model_validate(data)
        assert msg.symbol == "SOL"
        assert msg.mark_price == 97.35
        assert msg.mid_price == 97.315
        assert msg.funding_rate == -0.00015

    def test_trade_event(self):
        data = {
            "slot": "123456789",
            "slotIndex": 5,
            "timestamp": "1704110400000",
            "symbol": "SOL",
            "taker": "ABC123",
            "tradeSequenceNumber": "100",
            "side": "bid",
            "baseLotsFilled": "1000",
            "quoteLotsFilled": "150000",
            "feeInQuoteLots": "30",
            "baseAmount": 10.0,
            "quoteAmount": 1500.0,
            "numFills": 2,
        }
        msg = TradeEvent.model_validate(data)
        assert msg.slot == 123456789
        assert msg.symbol == "SOL"
        assert msg.base_amount == 10.0

    def test_trades_message(self):
        data = {
            "symbol": "SOL",
            "trades": [
                {
                    "slot": "100",
                    "slotIndex": 0,
                    "timestamp": "1700000000",
                    "symbol": "SOL",
                    "taker": "taker1",
                    "tradeSequenceNumber": "1",
                    "side": "ask",
                    "baseLotsFilled": "500",
                    "quoteLotsFilled": "75000",
                    "feeInQuoteLots": "15",
                    "baseAmount": 5.0,
                    "quoteAmount": 750.0,
                    "numFills": 1,
                }
            ],
        }
        msg = TradesMessage.model_validate(data)
        assert msg.symbol == "SOL"
        assert len(msg.trades) == 1

    def test_candle_data(self):
        data = {
            "candle": {
                "time": 1727181985,
                "low": 149.80,
                "high": 151.50,
                "open": 150.25,
                "close": 150.90,
                "volume": 1234.56,
                "tradeCount": 89,
            },
            "symbol": "SOL",
            "timeframe": "1m",
        }
        msg = CandleData.model_validate(data)
        assert msg.symbol == "SOL"
        assert msg.timeframe == "1m"
        assert msg.candle.open == 150.25

    def test_trader_state_from_raw(self):
        data = {
            "channel": "traderState",
            "authority": "ABC123",
            "traderPdaIndex": 0,
            "slot": 12345,
            "messageType": "snapshot",
            "version": 1,
            "subaccounts": [],
        }
        msg = TraderStateServerMessage.from_raw(data)
        assert msg.authority == "ABC123"
        assert msg.slot == 12345
        assert msg.message_type == "snapshot"
        assert msg.data["version"] == 1

    def test_timeframe_values(self):
        assert Timeframe.MINUTE_1 == "1m"
        assert Timeframe.HOUR_4 == "4h"
        assert Timeframe.DAY_1 == "1d"


# ---------------------------------------------------------------------------
# Client message dispatch (unit test without real WS)
# ---------------------------------------------------------------------------


class TestClientDispatch:
    def _make_client(self) -> PhoenixWSClient:
        return PhoenixWSClient("wss://test.com/ws")

    @pytest.mark.asyncio
    async def test_subscribe_creates_queue(self):
        client = self._make_client()
        queue, handle = await client.subscribe_to_orderbook("SOL")
        assert queue is not None
        assert handle is not None
        handle.unsubscribe()

    @pytest.mark.asyncio
    async def test_multiple_subscribers_same_key(self):
        client = self._make_client()
        q1, h1 = await client.subscribe_to_orderbook("SOL")
        q2, h2 = await client.subscribe_to_orderbook("SOL")
        # Both should receive broadcasts
        key = _key_orderbook("SOL")
        assert len(client._subscribers[key]) == 2
        h1.unsubscribe()
        assert len(client._subscribers[key]) == 1
        h2.unsubscribe()
        assert key not in client._subscribers

    @pytest.mark.asyncio
    async def test_dispatch_orderbook(self):
        client = self._make_client()
        queue, handle = await client.subscribe_to_orderbook("SOL")
        data = {
            "channel": "orderbook",
            "symbol": "SOL",
            "orderbook": {
                "bids": [[150.0, 100.0]],
                "asks": [[151.0, 100.0]],
                "mid": 150.5,
            },
        }
        client._dispatch_message("orderbook", data)
        msg = queue.get_nowait()
        assert isinstance(msg, L2BookUpdate)
        assert msg.symbol == "SOL"
        handle.unsubscribe()

    @pytest.mark.asyncio
    async def test_dispatch_all_mids(self):
        client = self._make_client()
        queue, handle = await client.subscribe_to_all_mids()
        data = {
            "channel": "allMids",
            "mids": {"SOL": 150.0},
            "slot": 1,
            "slotIndex": 0,
        }
        client._dispatch_message("allMids", data)
        msg = queue.get_nowait()
        assert isinstance(msg, AllMidsData)
        assert msg.mids["SOL"] == 150.0
        handle.unsubscribe()

    @pytest.mark.asyncio
    async def test_dispatch_market(self):
        client = self._make_client()
        queue, handle = await client.subscribe_to_market("SOL")
        data = {
            "channel": "market",
            "symbol": "SOL",
            "openInterest": 100.0,
            "markPx": 150.0,
            "midPx": 149.5,
            "oraclePx": 150.1,
            "prevDayPx": 148.0,
            "dayNtlVlm": 1000000.0,
            "funding": 0.0001,
        }
        client._dispatch_message("market", data)
        msg = queue.get_nowait()
        assert isinstance(msg, MarketStatsUpdate)
        assert msg.mark_price == 150.0
        handle.unsubscribe()

    @pytest.mark.asyncio
    async def test_dispatch_trader_state(self):
        client = self._make_client()
        queue, handle = await client.subscribe_to_trader_state("AUTH1", 0)
        data = {
            "channel": "traderState",
            "authority": "AUTH1",
            "traderPdaIndex": 0,
            "slot": 999,
            "messageType": "snapshot",
            "version": 1,
            "subaccounts": [],
        }
        client._dispatch_message("traderState", data)
        msg = queue.get_nowait()
        assert isinstance(msg, TraderStateServerMessage)
        assert msg.authority == "AUTH1"
        assert msg.message_type == "snapshot"
        handle.unsubscribe()

    @pytest.mark.asyncio
    async def test_dispatch_candles(self):
        client = self._make_client()
        queue, handle = await client.subscribe_to_candles("SOL", Timeframe.MINUTE_1)
        data = {
            "channel": "candles",
            "symbol": "SOL",
            "timeframe": "1m",
            "candle": {
                "time": 1727181985,
                "low": 149.80,
                "high": 151.50,
                "open": 150.25,
                "close": 150.90,
            },
        }
        client._dispatch_message("candles", data)
        msg = queue.get_nowait()
        assert isinstance(msg, CandleData)
        assert msg.symbol == "SOL"
        handle.unsubscribe()

    @pytest.mark.asyncio
    async def test_process_ping_pong(self):
        """Test that _process_message handles ping and sends pong."""
        client = self._make_client()
        sent_messages: list[str] = []

        class FakeWs:
            async def send(self, msg: str) -> None:
                sent_messages.append(msg)

        client._ws = FakeWs()  # type: ignore[assignment]
        await client._process_message(json.dumps({"type": "ping", "nonce": 42}))
        assert len(sent_messages) == 1
        pong = json.loads(sent_messages[0])
        assert pong == {"type": "pong", "nonce": 42}

    @pytest.mark.asyncio
    async def test_process_subscription_confirmed(self):
        """subscriptionConfirmed messages should be handled without error."""
        client = self._make_client()
        msg = json.dumps(
            {
                "type": "subscriptionConfirmed",
                "subscription": {"channel": "orderbook", "symbol": "SOL"},
            }
        )
        # Should not raise
        await client._process_message(msg)

    @pytest.mark.asyncio
    async def test_from_env(self):
        env = PhoenixEnv(
            api_url="https://api.test.com",
            api_key="test-key",
        )
        client = PhoenixWSClient.from_env(env)
        assert client.url == "wss://api.test.com/ws"
