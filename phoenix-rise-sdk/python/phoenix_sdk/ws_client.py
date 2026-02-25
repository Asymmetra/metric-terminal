from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from .config import PhoenixEnv
from .errors import ConnectionFailed, SubscriptionClosed
from .models.ws import (
    AllMidsData,
    CandleData,
    FundingRateMessage,
    L2BookUpdate,
    MarketStatsUpdate,
    Timeframe,
    TraderStateServerMessage,
    TradesMessage,
)

logger = logging.getLogger(__name__)

API_KEY_HEADER = "x-api-key"


class WsConnectionStatus(str, Enum):
    CONNECTING = "connecting"
    CONNECTED = "connected"
    CONNECTION_FAILED = "connection_failed"
    DISCONNECTED = "disconnected"


@dataclass(frozen=True)
class _SubscriptionKey:
    channel: str
    symbol: str | None = None
    authority: str | None = None
    trader_pda_index: int | None = None
    timeframe: str | None = None


def _key_all_mids() -> _SubscriptionKey:
    return _SubscriptionKey(channel="allMids")


def _key_funding_rate(symbol: str) -> _SubscriptionKey:
    return _SubscriptionKey(channel="fundingRate", symbol=symbol)


def _key_orderbook(symbol: str) -> _SubscriptionKey:
    return _SubscriptionKey(channel="orderbook", symbol=symbol)


def _key_trader_state(authority: str, trader_pda_index: int) -> _SubscriptionKey:
    return _SubscriptionKey(
        channel="traderState",
        authority=authority,
        trader_pda_index=trader_pda_index,
    )


def _key_market(symbol: str) -> _SubscriptionKey:
    return _SubscriptionKey(channel="market", symbol=symbol)


def _key_trades(symbol: str) -> _SubscriptionKey:
    return _SubscriptionKey(channel="trades", symbol=symbol)


def _key_candles(symbol: str, timeframe: str) -> _SubscriptionKey:
    return _SubscriptionKey(channel="candles", symbol=symbol, timeframe=timeframe)


def _build_subscription_payload(key: _SubscriptionKey) -> dict[str, Any]:
    """Build the subscription dict for the wire protocol."""
    sub: dict[str, Any] = {"channel": key.channel}
    if key.symbol is not None:
        sub["symbol"] = key.symbol
    if key.authority is not None:
        sub["authority"] = key.authority
    if key.trader_pda_index is not None:
        sub["traderPdaIndex"] = key.trader_pda_index
    if key.timeframe is not None:
        sub["timeframe"] = key.timeframe
    return sub


class SubscriptionHandle:
    """Handle for an active subscription. Call ``unsubscribe()`` to stop receiving messages."""

    def __init__(
        self,
        client: PhoenixWSClient,
        key: _SubscriptionKey,
        subscriber_id: int,
    ) -> None:
        self._client = client
        self._key = key
        self._subscriber_id = subscriber_id

    def unsubscribe(self) -> None:
        self._client._remove_subscriber(self._key, self._subscriber_id)

    def __del__(self) -> None:
        self.unsubscribe()


_CHANNEL_PARSERS: dict[str, type] = {
    "allMids": AllMidsData,
    "fundingRate": FundingRateMessage,
    "orderbook": L2BookUpdate,
    "market": MarketStatsUpdate,
    "trades": TradesMessage,
    "candles": CandleData,
}


class PhoenixWSClient:
    """Async WebSocket client for the Phoenix API.

    Manages a single WebSocket connection and routes incoming messages
    to per-subscription ``asyncio.Queue`` instances.
    """

    def __init__(self, ws_url: str, api_key: str | None = None) -> None:
        self._ws_url = ws_url
        self._api_key = api_key
        self._subscribers: dict[_SubscriptionKey, dict[int, asyncio.Queue[Any]]] = {}
        self._active_subscriptions: dict[_SubscriptionKey, dict[str, Any]] = {}
        self._next_id = 0
        self._ws: ClientConnection | None = None
        self._task: asyncio.Task[None] | None = None
        self._control: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self._status_queue: asyncio.Queue[WsConnectionStatus] | None = None

    @classmethod
    def from_env(cls, env: PhoenixEnv | None = None) -> PhoenixWSClient:
        if env is None:
            env = PhoenixEnv.load()
        return cls(ws_url=env.ws_url, api_key=env.api_key)

    # -- lifecycle -----------------------------------------------------------

    async def connect(self) -> None:
        """Connect to the WebSocket server and start the message loop."""
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._connection_manager())

    async def shutdown(self) -> None:
        """Gracefully close the connection."""
        await self._control.put(("shutdown", None))
        if self._task is not None:
            await self._task
            self._task = None

    async def __aenter__(self) -> PhoenixWSClient:
        await self.connect()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.shutdown()

    @property
    def url(self) -> str:
        return self._ws_url

    def enable_connection_status(self) -> asyncio.Queue[WsConnectionStatus]:
        """Enable connection status events. Returns a queue that receives status updates."""
        if self._status_queue is None:
            self._status_queue = asyncio.Queue()
        return self._status_queue

    # -- subscribe methods ---------------------------------------------------

    async def subscribe_to_all_mids(
        self,
    ) -> tuple[asyncio.Queue[AllMidsData], SubscriptionHandle]:
        key = _key_all_mids()
        return await self._subscribe(key)

    async def subscribe_to_funding_rate(
        self, symbol: str
    ) -> tuple[asyncio.Queue[FundingRateMessage], SubscriptionHandle]:
        key = _key_funding_rate(symbol)
        return await self._subscribe(key)

    async def subscribe_to_orderbook(
        self, symbol: str
    ) -> tuple[asyncio.Queue[L2BookUpdate], SubscriptionHandle]:
        key = _key_orderbook(symbol)
        return await self._subscribe(key)

    async def subscribe_to_trader_state(
        self, authority: str, trader_pda_index: int = 0
    ) -> tuple[asyncio.Queue[TraderStateServerMessage], SubscriptionHandle]:
        key = _key_trader_state(authority, trader_pda_index)
        return await self._subscribe(key)

    async def subscribe_to_market(
        self, symbol: str
    ) -> tuple[asyncio.Queue[MarketStatsUpdate], SubscriptionHandle]:
        key = _key_market(symbol)
        return await self._subscribe(key)

    async def subscribe_to_trades(
        self, symbol: str
    ) -> tuple[asyncio.Queue[TradesMessage], SubscriptionHandle]:
        key = _key_trades(symbol)
        return await self._subscribe(key)

    async def subscribe_to_candles(
        self, symbol: str, timeframe: Timeframe
    ) -> tuple[asyncio.Queue[CandleData], SubscriptionHandle]:
        key = _key_candles(symbol, timeframe.value)
        return await self._subscribe(key)

    # -- internal ------------------------------------------------------------

    async def _subscribe(
        self, key: _SubscriptionKey
    ) -> tuple[asyncio.Queue[Any], SubscriptionHandle]:
        queue: asyncio.Queue[Any] = asyncio.Queue()
        sid = self._next_id
        self._next_id += 1

        key_subs = self._subscribers.setdefault(key, {})
        is_first = len(key_subs) == 0
        key_subs[sid] = queue

        if is_first:
            payload = _build_subscription_payload(key)
            self._active_subscriptions[key] = payload
            await self._control.put(("subscribe", payload))

        handle = SubscriptionHandle(self, key, sid)
        return queue, handle

    def _remove_subscriber(self, key: _SubscriptionKey, sid: int) -> None:
        key_subs = self._subscribers.get(key)
        if key_subs is None:
            return
        key_subs.pop(sid, None)
        if not key_subs:
            del self._subscribers[key]
            payload = self._active_subscriptions.pop(key, None)
            if payload is not None:
                try:
                    self._control.put_nowait(("unsubscribe", payload))
                except Exception:
                    pass

    async def _connection_manager(self) -> None:
        if self._status_queue is not None:
            self._status_queue.put_nowait(WsConnectionStatus.CONNECTING)

        headers = {}
        if self._api_key:
            headers[API_KEY_HEADER] = self._api_key

        try:
            self._ws = await websockets.connect(
                self._ws_url,
                additional_headers=headers,
            )
        except Exception as exc:
            logger.error("Failed to connect to %s: %s", self._ws_url, exc)
            if self._status_queue is not None:
                self._status_queue.put_nowait(WsConnectionStatus.CONNECTION_FAILED)
            raise ConnectionFailed(str(exc)) from exc

        logger.info("Connected to WebSocket: %s", self._ws_url)
        if self._status_queue is not None:
            self._status_queue.put_nowait(WsConnectionStatus.CONNECTED)

        try:
            await self._message_loop()
        finally:
            await self._ws.close()
            self._ws = None
            if self._status_queue is not None:
                self._status_queue.put_nowait(
                    WsConnectionStatus.DISCONNECTED
                )

    async def _message_loop(self) -> None:
        assert self._ws is not None

        async def _recv_messages() -> None:
            assert self._ws is not None
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                await self._process_message(raw)

        recv_task = asyncio.create_task(_recv_messages())

        try:
            while True:
                # Check control queue with a short timeout, allowing
                # the recv task to surface exceptions promptly.
                try:
                    action, payload = await asyncio.wait_for(
                        self._control.get(), timeout=0.05
                    )
                except asyncio.TimeoutError:
                    if recv_task.done():
                        recv_task.result()  # propagate exception
                        return
                    continue

                if action == "shutdown":
                    return
                elif action == "subscribe":
                    msg = json.dumps({"type": "subscribe", "subscription": payload})
                    await self._ws.send(msg)
                elif action == "unsubscribe":
                    msg = json.dumps({"type": "unsubscribe", "subscription": payload})
                    await self._ws.send(msg)
        finally:
            recv_task.cancel()
            try:
                await recv_task
            except (asyncio.CancelledError, Exception):
                pass

    async def _process_message(self, text: str) -> None:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.debug("Received non-JSON message: %s", text[:200])
            return

        msg_type = data.get("type")

        # Handle ping
        if msg_type == "ping":
            nonce = data.get("nonce")
            logger.debug("Received ping with nonce: %s", nonce)
            pong = json.dumps({"type": "pong", "nonce": nonce})
            if self._ws is not None:
                await self._ws.send(pong)
            return

        # Handle subscription confirmed
        if msg_type == "subscriptionConfirmed":
            logger.debug("Subscription confirmed: %s", data.get("subscription"))
            return

        # Handle subscription error
        if msg_type == "subscriptionError":
            logger.error(
                "Subscription error: code=%s, message=%s",
                data.get("code"),
                data.get("message"),
            )
            return

        # Handle channel data messages
        channel = data.get("channel")
        if not channel:
            logger.debug("Unknown message: %s", text[:200])
            return

        self._dispatch_message(channel, data)

    def _dispatch_message(self, channel: str, data: dict[str, Any]) -> None:
        if channel == "error":
            logger.error(
                "Server error: code=%s, error=%s",
                data.get("code"),
                data.get("error"),
            )
            return

        if channel == "traderState":
            key = _key_trader_state(
                data.get("authority", ""),
                data.get("traderPdaIndex", 0),
            )
            parsed = TraderStateServerMessage.from_raw(data)
            self._broadcast(key, parsed)
            return

        if channel == "candles":
            timeframe = data.get("timeframe", "")
            symbol = data.get("symbol", "")
            key = _key_candles(symbol, timeframe)
        elif channel == "allMids":
            key = _key_all_mids()
        elif channel == "fundingRate":
            key = _key_funding_rate(data.get("symbol", ""))
        elif channel == "orderbook":
            key = _key_orderbook(data.get("symbol", ""))
        elif channel == "market":
            key = _key_market(data.get("symbol", ""))
        elif channel == "trades":
            key = _key_trades(data.get("symbol", ""))
        else:
            logger.debug("Unhandled channel: %s", channel)
            return

        model_cls = _CHANNEL_PARSERS.get(channel)
        if model_cls is None:
            return

        try:
            parsed = model_cls.model_validate(data)
        except Exception as exc:
            logger.debug("Failed to parse %s message: %s", channel, exc)
            return

        self._broadcast(key, parsed)

    def _broadcast(self, key: _SubscriptionKey, msg: Any) -> None:
        key_subs = self._subscribers.get(key)
        if not key_subs:
            return
        closed: list[int] = []
        for sid, queue in key_subs.items():
            try:
                queue.put_nowait(msg)
            except Exception:
                closed.append(sid)
        for sid in closed:
            logger.debug("Subscriber %d channel closed for %s", sid, key)
            key_subs.pop(sid, None)
