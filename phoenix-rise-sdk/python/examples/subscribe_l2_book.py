"""Example: Subscribe to orderbook and market stats via WebSocket.

Uses asyncio.wait with FIRST_COMPLETED to multiplex both subscriptions
in a single loop (Python equivalent of Rust's tokio::select!).

Run with:
  export PHOENIX_WS_URL=wss://public-api.phoenix.trade/ws
  python examples/subscribe_l2_book.py SOL

The symbol argument is required (e.g., "SOL", "BTC", "ETH").
"""

import asyncio
import sys

from phoenix_sdk import L2BookUpdate, MarketStatsUpdate, PhoenixWSClient


def handle_orderbook(msg: L2BookUpdate) -> None:
    book = msg.orderbook

    print(f"=== {msg.symbol} Orderbook Update ===")

    if book.bids and book.asks:
        best_bid_price, best_bid_qty = book.bids[0]
        best_ask_price, best_ask_qty = book.asks[0]
        print(f"  Best Bid:   ${best_bid_price:.4f} ({best_bid_qty:.2f})")
        print(f"  Best Ask:   ${best_ask_price:.4f} ({best_ask_qty:.2f})")

        spread = best_ask_price - best_bid_price
        print(f"  Spread:     ${spread:.6f}")

        mid = (best_bid_price + best_ask_price) / 2
        if mid > 0:
            print(f"  Spread %:   {(spread / mid) * 100:.4f}%")

    if book.mid is not None:
        print(f"  Mid Price:  ${book.mid:.4f}")

    bid_liquidity = sum(qty for _, qty in book.bids)
    ask_liquidity = sum(qty for _, qty in book.asks)
    print(f"  Bid Depth:  {len(book.bids)} levels ({bid_liquidity:.2f} total qty)")
    print(f"  Ask Depth:  {len(book.asks)} levels ({ask_liquidity:.2f} total qty)")

    if book.bids:
        print("\n  Top Bids:")
        for price, qty in book.bids[:3]:
            print(f"    ${price:.4f} x {qty:.2f}")

    if book.asks:
        print("\n  Top Asks:")
        for price, qty in book.asks[:3]:
            print(f"    ${price:.4f} x {qty:.2f}")

    print()


def handle_market_stats(msg: MarketStatsUpdate) -> None:
    print(f"=== {msg.symbol} Market Stats ===")
    print(f"  Mark Price:    ${msg.mark_price:.4f}")
    print(f"  Mid Price:     ${msg.mid_price:.4f}")
    print(f"  Oracle Price:  ${msg.oracle_price:.4f}")
    print(f"  Prev Day Px:   ${msg.prev_day_mark_price:.4f}")
    print(f"  Open Interest: {msg.open_interest:.2f}")
    print(f"  24h Volume:    ${msg.day_volume_usd:,.2f}")
    print(f"  Funding Rate:  {msg.funding_rate:.8f}")
    print()


async def main():
    if len(sys.argv) < 2:
        print("Usage: subscribe_l2_book.py <SYMBOL> (e.g., SOL, BTC)")
        sys.exit(1)

    symbol = sys.argv[1]

    print("Connecting to Phoenix WebSocket...")

    async with PhoenixWSClient.from_env() as client:
        print(f"Subscribing to orderbook and market stats for: {symbol}")

        book_queue, book_handle = await client.subscribe_to_orderbook(symbol)
        market_queue, market_handle = await client.subscribe_to_market(symbol)
        print("Subscribed! Waiting for updates...\n")

        # select!-style loop: wait on whichever queue has data first
        book_task = asyncio.create_task(book_queue.get())
        market_task = asyncio.create_task(market_queue.get())
        pending: set[asyncio.Task] = {book_task, market_task}

        while True:
            done, pending = await asyncio.wait(
                pending, return_when=asyncio.FIRST_COMPLETED
            )

            for task in done:
                msg = task.result()
                if isinstance(msg, L2BookUpdate):
                    handle_orderbook(msg)
                    pending.add(asyncio.create_task(book_queue.get()))
                elif isinstance(msg, MarketStatsUpdate):
                    handle_market_stats(msg)
                    pending.add(asyncio.create_task(market_queue.get()))


asyncio.run(main())
