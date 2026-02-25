"""Example: Withdraw and Deposit USDC with Phoenix protocol.

Withdraw flow (5 instructions):
  1. Create ATA for Phoenix tokens (if needed)
  2. Approve Ember to spend Phoenix tokens
  3. Create ATA for USDC (if needed)
  4. Withdraw Phoenix tokens from Phoenix protocol
  5. Convert Phoenix tokens to USDC via Ember

Deposit flow (3 instructions):
  1. Create ATA for Phoenix tokens (if needed)
  2. Convert USDC to Phoenix tokens via Ember
  3. Deposit Phoenix tokens into Phoenix protocol

Run with:
  export PHOENIX_API_KEY=your_api_key  # optional
  python examples/deposit_funds.py 100.0
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

from phoenix_sdk import PhoenixHttpClient, PhoenixTxBuilder, TraderKey

RPC_ENDPOINT = "https://api.mainnet-beta.solana.com"


async def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: deposit_funds.py <USDC_AMOUNT>")
        print("Example: deposit_funds.py 100.0")
        sys.exit(1)

    usdc_amount = float(sys.argv[1])
    if usdc_amount <= 0:
        print("Error: USDC amount must be greater than 0")
        sys.exit(1)

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

    keys = exchange.keys
    print("\n=== Exchange Keys ===")
    print(f"  Canonical Mint: {keys.canonical_mint}")
    print(f"  Global Vault: {keys.global_vault}")

    async with httpx.AsyncClient() as rpc:
        # --- Withdraw funds first ---
        print(f"\nWithdrawing ${usdc_amount:.2f} USDC...")
        print("  This will:")
        print("  1. Create Phoenix token ATA (if needed)")
        print("  2. Approve Ember to spend Phoenix tokens")
        print("  3. Create USDC ATA (if needed)")
        print("  4. Withdraw Phoenix tokens from the protocol")
        print("  5. Convert Phoenix tokens to USDC via Ember")

        withdraw_instructions = builder.build_withdraw_funds(
            trader.authority, trader.pda(), usdc_amount,
        )

        resp = await rpc.post(RPC_ENDPOINT, json={
            "jsonrpc": "2.0", "id": 1,
            "method": "getLatestBlockhash",
            "params": [{"commitment": "confirmed"}],
        })
        blockhash = Hash.from_string(resp.json()["result"]["value"]["blockhash"])

        msg = Message.new_with_blockhash(withdraw_instructions, keypair.pubkey(), blockhash)
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
            print(f"Withdraw transaction failed: {result['error']}")
            sys.exit(1)

        withdraw_sig = result["result"]
        print("\nWithdraw transaction confirmed!")
        print(f"Signature: {withdraw_sig}")
        print(f"Explorer: https://explorer.solana.com/tx/{withdraw_sig}")

        # --- Deposit funds ---
        print(f"\nDepositing ${usdc_amount:.2f} USDC...")
        print("  This will:")
        print("  1. Create Phoenix token ATA (if needed)")
        print("  2. Convert USDC to Phoenix tokens via Ember")
        print("  3. Deposit Phoenix tokens into the protocol")

        deposit_instructions = builder.build_deposit_funds(
            trader.authority, trader.pda(), usdc_amount,
        )

        resp = await rpc.post(RPC_ENDPOINT, json={
            "jsonrpc": "2.0", "id": 1,
            "method": "getLatestBlockhash",
            "params": [{"commitment": "confirmed"}],
        })
        blockhash = Hash.from_string(resp.json()["result"]["value"]["blockhash"])

        msg = Message.new_with_blockhash(deposit_instructions, keypair.pubkey(), blockhash)
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
            print(f"Deposit transaction failed: {result['error']}")
            sys.exit(1)

        deposit_sig = result["result"]
        print("\nDeposit transaction confirmed!")
        print(f"Signature: {deposit_sig}")
        print(f"Explorer: https://explorer.solana.com/tx/{deposit_sig}")


asyncio.run(main())
