"""Example: Send a market order using PhoenixTxBuilder.

Run with:
  export PHOENIX_API_KEY=your_api_key  # optional
  python examples/send_market_order.py SOL
"""

import asyncio
import base64
import json
import os
import sys
from pathlib import Path

import httpx
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import Message
from solders.transaction import Transaction

from phoenix_sdk import PhoenixHttpClient, PhoenixTxBuilder, Side, TraderKey

RPC_ENDPOINT = "https://api.mainnet-beta.solana.com"


async def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: send_market_order.py <SYMBOL>")
        print("Example: send_market_order.py SOL")
        sys.exit(1)

    symbol = sys.argv[1]

    # Load keypair
    keypair_path = os.environ.get(
        "KEYPAIR_PATH",
        str(Path.home() / ".config" / "solana" / "id.json"),
    )
    print(f"Loading keypair from: {keypair_path}")
    with open(keypair_path) as f:
        secret = bytes(json.load(f))
    keypair = Keypair.from_bytes(secret)
    trader = TraderKey(keypair.pubkey())

    print(f"Trader authority: {trader.authority}")
    print(f"Trader PDA: {trader.pda()}")

    # Fetch exchange metadata
    print("\nFetching exchange metadata...")
    async with PhoenixHttpClient.from_env() as http:
        exchange = await http.get_exchange()

    builder = PhoenixTxBuilder(exchange)

    market = builder.get_market(symbol)
    if market:
        print(f"\n=== {market.symbol} Market ===")
        print(f"  Market Key: {market.market_pubkey}")
        print(f"  Spline Collection: {market.spline_pubkey}")
        print(f"  Taker Fee: {market.taker_fee * 100:.4f}%")
        print(f"  Maker Fee: {market.maker_fee * 100:.4f}%")

    # Build market order instructions
    num_base_lots = 67
    print(f"\nPlacing market order: {symbol} {num_base_lots} base lots")
    instructions = builder.build_market_order(
        trader.authority, trader.pda(), symbol, Side.BID, num_base_lots,
    )

    # Send transaction
    async with httpx.AsyncClient() as rpc:
        resp = await rpc.post(RPC_ENDPOINT, json={
            "jsonrpc": "2.0", "id": 1,
            "method": "getLatestBlockhash",
            "params": [{"commitment": "confirmed"}],
        })
        blockhash = Hash.from_string(resp.json()["result"]["value"]["blockhash"])

        msg = Message.new_with_blockhash(instructions, keypair.pubkey(), blockhash)
        tx = Transaction.new_unsigned(msg)
        tx.sign([keypair], blockhash)

        resp = await rpc.post(RPC_ENDPOINT, json={
            "jsonrpc": "2.0", "id": 1,
            "method": "sendTransaction",
            "params": [
                base64.b64encode(bytes(tx)).decode("ascii"),
                {"encoding": "base64", "skipPreflight": False,
                 "preflightCommitment": "confirmed"},
            ],
        })
        result = resp.json()

    if "error" in result:
        print(f"Transaction failed: {result['error']}")
        sys.exit(1)

    signature = result["result"]
    print("Transaction confirmed!")
    print(f"Signature: {signature}")
    print(f"Explorer: https://explorer.solana.com/tx/{signature}")


asyncio.run(main())
