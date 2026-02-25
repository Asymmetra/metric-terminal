"""Low-level Solana instruction builders for Phoenix perpetuals exchange.

Port of ``rust/ix/src/``.  Every function returns a
``solders.instruction.Instruction`` ready for inclusion in a transaction.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from enum import IntEnum

from solders.instruction import AccountMeta, Instruction
from solders.pubkey import Pubkey

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PHOENIX_PROGRAM_ID = Pubkey.from_string("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih")
PHOENIX_LOG_AUTHORITY = Pubkey.from_string("GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS")
PHOENIX_GLOBAL_CONFIGURATION = Pubkey.from_string("2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ")
EMBER_PROGRAM_ID = Pubkey.from_string("EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy")
USDC_MINT = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
SPL_TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")

# ---------------------------------------------------------------------------
# Discriminants  (first 8 bytes of SHA-256)
# ---------------------------------------------------------------------------


def compute_discriminant(name: str) -> bytes:
    return hashlib.sha256(name.encode()).digest()[:8]


PLACE_LIMIT_ORDER_DISC = compute_discriminant("global:place_limit_order")
PLACE_MARKET_ORDER_DISC = compute_discriminant("global:place_market_order")
CANCEL_ORDERS_BY_ID_DISC = compute_discriminant("global:cancel_orders_by_id")
DEPOSIT_FUNDS_DISC = compute_discriminant("global:deposit_funds")
WITHDRAW_FUNDS_DISC = compute_discriminant("global:withdraw_funds")
EMBER_DEPOSIT_DISC = compute_discriminant("global:deposit")
EMBER_WITHDRAW_DISC = compute_discriminant("global:withdraw")

# ---------------------------------------------------------------------------
# PDA derivation
# ---------------------------------------------------------------------------


def get_associated_token_address(owner: Pubkey, mint: Pubkey) -> Pubkey:
    pda, _ = Pubkey.find_program_address(
        [bytes(owner), bytes(SPL_TOKEN_PROGRAM_ID), bytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    return pda


def get_ember_state_address() -> Pubkey:
    pda, _ = Pubkey.find_program_address(
        [bytes(PHOENIX_PROGRAM_ID), b"state"],
        EMBER_PROGRAM_ID,
    )
    return pda


def get_ember_vault_address() -> Pubkey:
    pda, _ = Pubkey.find_program_address(
        [bytes(PHOENIX_PROGRAM_ID), b"vault"],
        EMBER_PROGRAM_ID,
    )
    return pda


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class IxSide(IntEnum):
    BID = 0
    ASK = 1


class OrderFlags(IntEnum):
    NONE = 0
    REDUCE_ONLY = 128


class SelfTradeBehavior(IntEnum):
    ABORT = 0
    CANCEL_PROVIDE = 1
    DECREMENT_TAKE = 2


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CancelId:
    price_in_ticks: int
    order_sequence_number: int


MAX_CANCEL_ORDER_IDS = 100

# ---------------------------------------------------------------------------
# Borsh encoding helpers
# ---------------------------------------------------------------------------


def _u8(v: int) -> bytes:
    return struct.pack("<B", v)


def _u32(v: int) -> bytes:
    return struct.pack("<I", v)


def _u64(v: int) -> bytes:
    return struct.pack("<Q", v)


def _u128(v: int) -> bytes:
    return v.to_bytes(16, "little")


def _bool(v: bool) -> bytes:
    return b"\x01" if v else b"\x00"


def _option_u64(v: int | None) -> bytes:
    if v is None:
        return b"\x00"
    return b"\x01" + _u64(v)


def _encode_cancel_id(cid: CancelId) -> bytes:
    return _u32(0) + _u64(cid.price_in_ticks) + _u64(cid.order_sequence_number)


def _encode_limit_order_packet(
    side: IxSide,
    price_in_ticks: int,
    num_base_lots: int,
    self_trade_behavior: SelfTradeBehavior = SelfTradeBehavior.ABORT,
    match_limit: int | None = None,
    client_order_id: int = 0,
    last_valid_slot: int | None = None,
    order_flags: OrderFlags = OrderFlags.NONE,
    cancel_existing: bool = False,
) -> bytes:
    # OrderPacketKind::Limit discriminant = 1
    return (
        _u8(1)
        + _u8(side)
        + _u64(price_in_ticks)
        + _u64(num_base_lots)
        + _u8(self_trade_behavior)
        + _option_u64(match_limit)
        + _u128(client_order_id)
        + _option_u64(last_valid_slot)
        + _u8(order_flags)
        + _bool(cancel_existing)
    )


def _encode_ioc_order_packet(
    side: IxSide,
    num_base_lots: int,
    price_in_ticks: int | None = None,
    num_quote_lots: int | None = None,
    min_base_lots_to_fill: int = 0,
    min_quote_lots_to_fill: int = 0,
    self_trade_behavior: SelfTradeBehavior = SelfTradeBehavior.ABORT,
    match_limit: int | None = None,
    client_order_id: int = 0,
    last_valid_slot: int | None = None,
    order_flags: OrderFlags = OrderFlags.NONE,
    cancel_existing: bool = False,
) -> bytes:
    # OrderPacketKind::ImmediateOrCancel discriminant = 2
    return (
        _u8(2)
        + _u8(side)
        + _option_u64(price_in_ticks)
        + _u64(num_base_lots)
        + _option_u64(num_quote_lots)
        + _u64(min_base_lots_to_fill)
        + _u64(min_quote_lots_to_fill)
        + _u8(self_trade_behavior)
        + _option_u64(match_limit)
        + _u128(client_order_id)
        + _option_u64(last_valid_slot)
        + _u8(order_flags)
        + _bool(cancel_existing)
    )


# ---------------------------------------------------------------------------
# Account-list helpers (private)
# ---------------------------------------------------------------------------


def _market_action_accounts(
    trader: Pubkey,
    trader_account: Pubkey,
    perp_asset_map: Pubkey,
    global_trader_index: list[Pubkey],
    active_trader_buffer: list[Pubkey],
    orderbook: Pubkey,
    spline_collection: Pubkey,
) -> list[AccountMeta]:
    accounts: list[AccountMeta] = [
        AccountMeta(PHOENIX_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(PHOENIX_LOG_AUTHORITY, is_signer=False, is_writable=False),
        AccountMeta(PHOENIX_GLOBAL_CONFIGURATION, is_signer=False, is_writable=True),
        AccountMeta(trader, is_signer=True, is_writable=False),
        AccountMeta(trader_account, is_signer=False, is_writable=True),
        AccountMeta(perp_asset_map, is_signer=False, is_writable=True),
    ]
    for addr in global_trader_index:
        accounts.append(AccountMeta(addr, is_signer=False, is_writable=True))
    for addr in active_trader_buffer:
        accounts.append(AccountMeta(addr, is_signer=False, is_writable=True))
    accounts.append(AccountMeta(orderbook, is_signer=False, is_writable=True))
    accounts.append(AccountMeta(spline_collection, is_signer=False, is_writable=True))
    return accounts


# ---------------------------------------------------------------------------
# Instruction builders
# ---------------------------------------------------------------------------


def create_place_limit_order_ix(
    trader: Pubkey,
    trader_account: Pubkey,
    perp_asset_map: Pubkey,
    orderbook: Pubkey,
    spline_collection: Pubkey,
    global_trader_index: list[Pubkey],
    active_trader_buffer: list[Pubkey],
    side: IxSide,
    price_in_ticks: int,
    num_base_lots: int,
    *,
    self_trade_behavior: SelfTradeBehavior = SelfTradeBehavior.ABORT,
    match_limit: int | None = None,
    client_order_id: int = 0,
    last_valid_slot: int | None = None,
    order_flags: OrderFlags = OrderFlags.NONE,
    cancel_existing: bool = False,
) -> Instruction:
    if not global_trader_index:
        raise ValueError("global_trader_index must not be empty")
    if not active_trader_buffer:
        raise ValueError("active_trader_buffer must not be empty")

    data = PLACE_LIMIT_ORDER_DISC + _encode_limit_order_packet(
        side=side,
        price_in_ticks=price_in_ticks,
        num_base_lots=num_base_lots,
        self_trade_behavior=self_trade_behavior,
        match_limit=match_limit,
        client_order_id=client_order_id,
        last_valid_slot=last_valid_slot,
        order_flags=order_flags,
        cancel_existing=cancel_existing,
    )
    accounts = _market_action_accounts(
        trader, trader_account, perp_asset_map,
        global_trader_index, active_trader_buffer,
        orderbook, spline_collection,
    )
    return Instruction(PHOENIX_PROGRAM_ID, data, accounts)


def create_place_market_order_ix(
    trader: Pubkey,
    trader_account: Pubkey,
    perp_asset_map: Pubkey,
    orderbook: Pubkey,
    spline_collection: Pubkey,
    global_trader_index: list[Pubkey],
    active_trader_buffer: list[Pubkey],
    side: IxSide,
    num_base_lots: int,
    *,
    price_in_ticks: int | None = None,
    num_quote_lots: int | None = None,
    min_base_lots_to_fill: int = 0,
    min_quote_lots_to_fill: int = 0,
    self_trade_behavior: SelfTradeBehavior = SelfTradeBehavior.ABORT,
    match_limit: int | None = None,
    client_order_id: int = 0,
    last_valid_slot: int | None = None,
    order_flags: OrderFlags = OrderFlags.NONE,
    cancel_existing: bool = False,
) -> Instruction:
    if not global_trader_index:
        raise ValueError("global_trader_index must not be empty")
    if not active_trader_buffer:
        raise ValueError("active_trader_buffer must not be empty")

    data = PLACE_MARKET_ORDER_DISC + _encode_ioc_order_packet(
        side=side,
        num_base_lots=num_base_lots,
        price_in_ticks=price_in_ticks,
        num_quote_lots=num_quote_lots,
        min_base_lots_to_fill=min_base_lots_to_fill,
        min_quote_lots_to_fill=min_quote_lots_to_fill,
        self_trade_behavior=self_trade_behavior,
        match_limit=match_limit,
        client_order_id=client_order_id,
        last_valid_slot=last_valid_slot,
        order_flags=order_flags,
        cancel_existing=cancel_existing,
    )
    accounts = _market_action_accounts(
        trader, trader_account, perp_asset_map,
        global_trader_index, active_trader_buffer,
        orderbook, spline_collection,
    )
    return Instruction(PHOENIX_PROGRAM_ID, data, accounts)


def create_cancel_orders_by_id_ix(
    trader: Pubkey,
    trader_account: Pubkey,
    perp_asset_map: Pubkey,
    orderbook: Pubkey,
    spline_collection: Pubkey,
    global_trader_index: list[Pubkey],
    active_trader_buffer: list[Pubkey],
    order_ids: list[CancelId],
) -> Instruction:
    if not global_trader_index:
        raise ValueError("global_trader_index must not be empty")
    if not active_trader_buffer:
        raise ValueError("active_trader_buffer must not be empty")
    if not order_ids:
        raise ValueError("order_ids must not be empty")
    if len(order_ids) > MAX_CANCEL_ORDER_IDS:
        raise ValueError(f"order_ids must not exceed {MAX_CANCEL_ORDER_IDS}")

    data = CANCEL_ORDERS_BY_ID_DISC + _u32(len(order_ids))
    for cid in order_ids:
        data += _encode_cancel_id(cid)

    accounts = _market_action_accounts(
        trader, trader_account, perp_asset_map,
        global_trader_index, active_trader_buffer,
        orderbook, spline_collection,
    )
    return Instruction(PHOENIX_PROGRAM_ID, data, accounts)


def create_deposit_funds_ix(
    trader: Pubkey,
    trader_account: Pubkey,
    canonical_mint: Pubkey,
    global_vault: Pubkey,
    trader_token_account: Pubkey,
    global_trader_index: list[Pubkey],
    active_trader_buffer: list[Pubkey],
    amount: int,
) -> Instruction:
    if not global_trader_index:
        raise ValueError("global_trader_index must not be empty")
    if not active_trader_buffer:
        raise ValueError("active_trader_buffer must not be empty")
    if amount <= 0:
        raise ValueError("amount must be greater than 0")

    data = DEPOSIT_FUNDS_DISC + _u64(amount)

    accounts: list[AccountMeta] = [
        AccountMeta(PHOENIX_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(PHOENIX_LOG_AUTHORITY, is_signer=False, is_writable=False),
        AccountMeta(PHOENIX_GLOBAL_CONFIGURATION, is_signer=False, is_writable=True),
        AccountMeta(trader, is_signer=True, is_writable=False),
        AccountMeta(trader_token_account, is_signer=False, is_writable=True),
        AccountMeta(trader_account, is_signer=False, is_writable=True),
        AccountMeta(global_vault, is_signer=False, is_writable=True),
        AccountMeta(SPL_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    for addr in global_trader_index:
        accounts.append(AccountMeta(addr, is_signer=False, is_writable=True))
    for addr in active_trader_buffer:
        accounts.append(AccountMeta(addr, is_signer=False, is_writable=True))

    return Instruction(PHOENIX_PROGRAM_ID, data, accounts)


def create_withdraw_funds_ix(
    trader: Pubkey,
    trader_account: Pubkey,
    perp_asset_map: Pubkey,
    global_vault: Pubkey,
    trader_token_account: Pubkey,
    global_trader_index: list[Pubkey],
    active_trader_buffer: list[Pubkey],
    withdraw_queue: Pubkey,
    amount: int,
) -> Instruction:
    if not global_trader_index:
        raise ValueError("global_trader_index must not be empty")
    if not active_trader_buffer:
        raise ValueError("active_trader_buffer must not be empty")
    if amount <= 0:
        raise ValueError("amount must be greater than 0")

    data = WITHDRAW_FUNDS_DISC + _u64(amount)

    accounts: list[AccountMeta] = [
        AccountMeta(PHOENIX_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(PHOENIX_LOG_AUTHORITY, is_signer=False, is_writable=False),
        AccountMeta(PHOENIX_GLOBAL_CONFIGURATION, is_signer=False, is_writable=True),
        AccountMeta(trader, is_signer=True, is_writable=False),
        AccountMeta(trader_account, is_signer=False, is_writable=True),
        AccountMeta(perp_asset_map, is_signer=False, is_writable=True),
        AccountMeta(global_vault, is_signer=False, is_writable=True),
        AccountMeta(trader_token_account, is_signer=False, is_writable=True),
        AccountMeta(SPL_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    for addr in global_trader_index:
        accounts.append(AccountMeta(addr, is_signer=False, is_writable=True))
    for addr in active_trader_buffer:
        accounts.append(AccountMeta(addr, is_signer=False, is_writable=True))
    accounts.append(AccountMeta(withdraw_queue, is_signer=False, is_writable=True))

    return Instruction(PHOENIX_PROGRAM_ID, data, accounts)


def create_ember_deposit_ix(
    trader: Pubkey,
    ember_state: Pubkey,
    ember_vault: Pubkey,
    usdc_mint: Pubkey,
    canonical_mint: Pubkey,
    trader_usdc_account: Pubkey,
    trader_phoenix_account: Pubkey,
    amount: int,
) -> Instruction:
    if amount <= 0:
        raise ValueError("amount must be greater than 0")

    data = EMBER_DEPOSIT_DISC + _u64(amount)

    accounts: list[AccountMeta] = [
        AccountMeta(trader, is_signer=True, is_writable=False),
        AccountMeta(ember_state, is_signer=False, is_writable=False),
        AccountMeta(usdc_mint, is_signer=False, is_writable=False),
        AccountMeta(canonical_mint, is_signer=False, is_writable=True),
        AccountMeta(trader_usdc_account, is_signer=False, is_writable=True),
        AccountMeta(trader_phoenix_account, is_signer=False, is_writable=True),
        AccountMeta(ember_vault, is_signer=False, is_writable=True),
        AccountMeta(SPL_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    return Instruction(EMBER_PROGRAM_ID, data, accounts)


def create_ember_withdraw_ix(
    trader: Pubkey,
    ember_state: Pubkey,
    usdc_mint: Pubkey,
    canonical_mint: Pubkey,
    trader_usdc_account: Pubkey,
    trader_phoenix_account: Pubkey,
    ember_vault: Pubkey,
    amount: int | None,
) -> Instruction:
    if amount is not None and amount <= 0:
        raise ValueError("amount must be greater than 0 or None for full withdrawal")

    data = EMBER_WITHDRAW_DISC + _option_u64(amount)

    accounts: list[AccountMeta] = [
        AccountMeta(trader, is_signer=True, is_writable=False),
        AccountMeta(ember_state, is_signer=False, is_writable=False),
        AccountMeta(usdc_mint, is_signer=False, is_writable=False),
        AccountMeta(canonical_mint, is_signer=False, is_writable=True),
        AccountMeta(trader_usdc_account, is_signer=False, is_writable=True),
        AccountMeta(trader_phoenix_account, is_signer=False, is_writable=True),
        AccountMeta(ember_vault, is_signer=False, is_writable=True),
        AccountMeta(SPL_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    return Instruction(EMBER_PROGRAM_ID, data, accounts)


def create_associated_token_account_idempotent_ix(
    payer: Pubkey,
    owner: Pubkey,
    mint: Pubkey,
) -> Instruction:
    ata = get_associated_token_address(owner, mint)

    accounts: list[AccountMeta] = [
        AccountMeta(payer, is_signer=True, is_writable=True),
        AccountMeta(ata, is_signer=False, is_writable=True),
        AccountMeta(owner, is_signer=False, is_writable=False),
        AccountMeta(mint, is_signer=False, is_writable=False),
        AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(SPL_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    # CreateIdempotent discriminant = 1
    return Instruction(ASSOCIATED_TOKEN_PROGRAM_ID, bytes([1]), accounts)


def create_spl_approve_ix(
    source: Pubkey,
    delegate: Pubkey,
    owner: Pubkey,
    amount: int,
) -> Instruction:
    data = bytes([4]) + _u64(amount)

    accounts: list[AccountMeta] = [
        AccountMeta(source, is_signer=False, is_writable=True),
        AccountMeta(delegate, is_signer=False, is_writable=False),
        AccountMeta(owner, is_signer=True, is_writable=False),
    ]
    return Instruction(SPL_TOKEN_PROGRAM_ID, data, accounts)
