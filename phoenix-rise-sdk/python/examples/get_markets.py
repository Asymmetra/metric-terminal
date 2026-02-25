import asyncio
import os
import sys

from phoenix_sdk import (
    CandlesQueryParams,
    CollateralHistoryQueryParams,
    FundingHistoryQueryParams,
    OrderHistoryQueryParams,
    PhoenixHttpClient,
    TradeHistoryQueryParams,
)


async def main():
    authority = os.environ.get("PHOENIX_AUTHORITY")

    async with PhoenixHttpClient.from_env() as client:
        # Exchange keys
        keys = await client.get_exchange_keys()
        print(f"Global config: {keys.global_config}")
        print(f"Canonical mint: {keys.canonical_mint}")
        print()

        # All markets
        markets = await client.get_markets()
        for m in markets:
            print(f"{m.symbol}: taker={m.taker_fee:.4%} maker={m.maker_fee:.4%}")
        print()

        # Single market
        market = await client.get_market("SOL")
        print(f"SOL tick_size={market.tick_size} isolated_only={market.isolated_only}")
        print()

        # Full exchange config
        exchange = await client.get_exchange()
        print(f"Exchange: {len(exchange.markets)} markets")
        print()

        # Candles
        candles = await client.get_candles(
            CandlesQueryParams("SOL", "1m").with_limit(5)
        )
        for c in candles:
            print(f"  candle t={c.time} o={c.open} h={c.high} l={c.low} c={c.close}")
        print()

        if not authority:
            print("Set PHOENIX_AUTHORITY to query trader endpoints")
            return

        # Trader state
        traders = await client.get_traders(authority)
        print(f"Trader subaccounts: {len(traders)}")
        for t in traders:
            print(f"  [{t.trader_pda_index}] collateral={t.collateral_balance.ui} risk={t.risk_state.value}")
        print()

        # Collateral history
        collateral = await client.get_collateral_history(
            authority, CollateralHistoryQueryParams(10)
        )
        print(f"Collateral events: {len(collateral.data)} (has_more={collateral.has_more})")
        for e in collateral.data:
            print(f"  {e.timestamp} {e.event_type} {e.amount}")
        print()

        # Funding history
        funding = await client.get_funding_history(
            authority, FundingHistoryQueryParams().with_symbol("SOL").with_limit(10)
        )
        print(f"Funding events: {len(funding.events)} (has_more={funding.has_more})")
        for e in funding.events:
            print(f"  {e.timestamp} {e.symbol} payment={e.funding_payment}")
        print()

        # Order history
        orders = await client.get_order_history(
            authority, OrderHistoryQueryParams(10)
        )
        print(f"Orders: {len(orders.data)} (has_more={orders.has_more})")
        for o in orders.data:
            print(f"  {o.market_symbol} {o.side.value} {o.base_qty}@{o.price} status={o.status.value}")
        print()

        # Trade history
        trades = await client.get_trade_history(
            authority, TradeHistoryQueryParams().with_limit(10)
        )
        print(f"Trades: {len(trades.data)} (has_more={trades.has_more})")
        for t in trades.data:
            print(f"  {t.market_symbol} {t.base_qty}@{t.price} {t.timestamp}")


asyncio.run(main())
