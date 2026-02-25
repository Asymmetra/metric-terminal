"""High-level transaction builder for Phoenix perpetuals exchange.

Port of ``rust/sdk/src/tx_builder.rs``.  Wraps the low-level instruction
builders in :mod:`phoenix_sdk.ix` with exchange-metadata lookup and
user-friendly parameters (symbol names, USD prices).
"""

from __future__ import annotations

from solders.instruction import Instruction
from solders.pubkey import Pubkey

from .ix import (
    USDC_MINT,
    CancelId,
    IxSide,
    create_associated_token_account_idempotent_ix,
    create_cancel_orders_by_id_ix,
    create_deposit_funds_ix,
    create_ember_deposit_ix,
    create_ember_withdraw_ix,
    create_place_limit_order_ix,
    create_place_market_order_ix,
    create_spl_approve_ix,
    create_withdraw_funds_ix,
    get_associated_token_address,
    get_ember_state_address,
    get_ember_vault_address,
)
from .models.core import Side
from .models.exchange import ExchangeMarketConfig, ExchangeResponse

# Quote-lot decimals are fixed at 6 (micro-USD).
_QUOTE_LOT_DECIMALS = 6


def _side_to_ix(side: Side) -> IxSide:
    if side is Side.BID:
        return IxSide.BID
    return IxSide.ASK


class PhoenixTxBuilder:
    """Builds Solana instructions from exchange metadata.

    Parameters
    ----------
    exchange:
        The full exchange response from ``PhoenixHttpClient.get_exchange()``.
    """

    def __init__(self, exchange: ExchangeResponse) -> None:
        self._exchange = exchange
        self._markets: dict[str, ExchangeMarketConfig] = {
            m.symbol.upper(): m for m in exchange.markets
        }

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    def get_market(self, symbol: str) -> ExchangeMarketConfig | None:
        return self._markets.get(symbol.upper())

    def price_to_ticks(self, symbol: str, price: float) -> int:
        """Convert a USD price to ticks for a given market.

        Formula (from ``rust/math/src/market_math.rs``):
            ``round(price * 10**quote_dec / (tick_size * 10**base_dec))``
        where ``quote_dec`` is always 6.
        """
        market = self._markets.get(symbol.upper())
        if market is None:
            raise ValueError(f"Unknown symbol: {symbol}")
        if price <= 0.0:
            raise ValueError("price must be positive")
        numerator = price * (10**_QUOTE_LOT_DECIMALS)
        denominator = market.tick_size * (10**market.base_lots_decimals)
        if denominator == 0:
            raise ValueError("tick_size * 10**base_lots_decimals is zero")
        return round(numerator / denominator)

    # ------------------------------------------------------------------
    # Order instructions
    # ------------------------------------------------------------------

    def build_market_order(
        self,
        authority: Pubkey,
        trader_pda: Pubkey,
        symbol: str,
        side: Side,
        num_base_lots: int,
    ) -> list[Instruction]:
        market = self._require_market(symbol)
        addrs = self._parse_addresses(market)
        ix = create_place_market_order_ix(
            trader=authority,
            trader_account=trader_pda,
            perp_asset_map=addrs["perp_asset_map"],
            orderbook=addrs["orderbook"],
            spline_collection=addrs["spline_collection"],
            global_trader_index=addrs["global_trader_index"],
            active_trader_buffer=addrs["active_trader_buffer"],
            side=_side_to_ix(side),
            num_base_lots=num_base_lots,
        )
        return [ix]

    def build_limit_order(
        self,
        authority: Pubkey,
        trader_pda: Pubkey,
        symbol: str,
        side: Side,
        price: float,
        num_base_lots: int,
    ) -> list[Instruction]:
        market = self._require_market(symbol)
        addrs = self._parse_addresses(market)
        ticks = self.price_to_ticks(symbol, price)
        ix = create_place_limit_order_ix(
            trader=authority,
            trader_account=trader_pda,
            perp_asset_map=addrs["perp_asset_map"],
            orderbook=addrs["orderbook"],
            spline_collection=addrs["spline_collection"],
            global_trader_index=addrs["global_trader_index"],
            active_trader_buffer=addrs["active_trader_buffer"],
            side=_side_to_ix(side),
            price_in_ticks=ticks,
            num_base_lots=num_base_lots,
        )
        return [ix]

    def build_cancel_orders(
        self,
        authority: Pubkey,
        trader_pda: Pubkey,
        symbol: str,
        order_ids: list[CancelId],
    ) -> list[Instruction]:
        market = self._require_market(symbol)
        addrs = self._parse_addresses(market)
        ix = create_cancel_orders_by_id_ix(
            trader=authority,
            trader_account=trader_pda,
            perp_asset_map=addrs["perp_asset_map"],
            orderbook=addrs["orderbook"],
            spline_collection=addrs["spline_collection"],
            global_trader_index=addrs["global_trader_index"],
            active_trader_buffer=addrs["active_trader_buffer"],
            order_ids=order_ids,
        )
        return [ix]

    # ------------------------------------------------------------------
    # Deposit / Withdraw
    # ------------------------------------------------------------------

    def build_deposit_funds(
        self,
        authority: Pubkey,
        trader_pda: Pubkey,
        usdc_amount: float,
    ) -> list[Instruction]:
        """Build deposit instructions (3 ixs: create ATA, ember deposit, phoenix deposit)."""
        amount = int(usdc_amount * 1_000_000)
        keys = self._exchange.keys

        canonical_mint = Pubkey.from_string(keys.canonical_mint)
        global_vault = Pubkey.from_string(keys.global_vault)
        global_trader_index = [Pubkey.from_string(s) for s in keys.global_trader_index]
        active_trader_buffer = [Pubkey.from_string(s) for s in keys.active_trader_buffer]

        trader_usdc_ata = get_associated_token_address(authority, USDC_MINT)
        trader_phoenix_ata = get_associated_token_address(authority, canonical_mint)
        ember_state = get_ember_state_address()
        ember_vault = get_ember_vault_address()

        create_ata_ix = create_associated_token_account_idempotent_ix(
            authority, authority, canonical_mint,
        )
        ember_ix = create_ember_deposit_ix(
            trader=authority,
            ember_state=ember_state,
            ember_vault=ember_vault,
            usdc_mint=USDC_MINT,
            canonical_mint=canonical_mint,
            trader_usdc_account=trader_usdc_ata,
            trader_phoenix_account=trader_phoenix_ata,
            amount=amount,
        )
        deposit_ix = create_deposit_funds_ix(
            trader=authority,
            trader_account=trader_pda,
            canonical_mint=canonical_mint,
            global_vault=global_vault,
            trader_token_account=trader_phoenix_ata,
            global_trader_index=global_trader_index,
            active_trader_buffer=active_trader_buffer,
            amount=amount,
        )
        return [create_ata_ix, ember_ix, deposit_ix]

    def build_withdraw_funds(
        self,
        authority: Pubkey,
        trader_pda: Pubkey,
        usdc_amount: float,
    ) -> list[Instruction]:
        """Build withdraw instructions (5 ixs: create phoenix ATA, approve, create USDC ATA, withdraw, ember withdraw)."""
        amount = int(usdc_amount * 1_000_000)
        keys = self._exchange.keys

        canonical_mint = Pubkey.from_string(keys.canonical_mint)
        global_vault = Pubkey.from_string(keys.global_vault)
        perp_asset_map = Pubkey.from_string(keys.perp_asset_map)
        withdraw_queue = Pubkey.from_string(keys.withdraw_queue)
        global_trader_index = [Pubkey.from_string(s) for s in keys.global_trader_index]
        active_trader_buffer = [Pubkey.from_string(s) for s in keys.active_trader_buffer]

        trader_usdc_ata = get_associated_token_address(authority, USDC_MINT)
        trader_phoenix_ata = get_associated_token_address(authority, canonical_mint)
        ember_state = get_ember_state_address()
        ember_vault = get_ember_vault_address()

        create_phoenix_ata_ix = create_associated_token_account_idempotent_ix(
            authority, authority, canonical_mint,
        )
        approve_ix = create_spl_approve_ix(
            source=trader_phoenix_ata,
            delegate=ember_state,
            owner=authority,
            amount=amount,
        )
        create_usdc_ata_ix = create_associated_token_account_idempotent_ix(
            authority, authority, USDC_MINT,
        )
        withdraw_ix = create_withdraw_funds_ix(
            trader=authority,
            trader_account=trader_pda,
            perp_asset_map=perp_asset_map,
            global_vault=global_vault,
            trader_token_account=trader_phoenix_ata,
            global_trader_index=global_trader_index,
            active_trader_buffer=active_trader_buffer,
            withdraw_queue=withdraw_queue,
            amount=amount,
        )
        ember_ix = create_ember_withdraw_ix(
            trader=authority,
            ember_state=ember_state,
            usdc_mint=USDC_MINT,
            canonical_mint=canonical_mint,
            trader_usdc_account=trader_usdc_ata,
            trader_phoenix_account=trader_phoenix_ata,
            ember_vault=ember_vault,
            amount=amount,
        )
        return [create_phoenix_ata_ix, approve_ix, create_usdc_ata_ix, withdraw_ix, ember_ix]

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _require_market(self, symbol: str) -> ExchangeMarketConfig:
        market = self._markets.get(symbol.upper())
        if market is None:
            raise ValueError(f"Unknown symbol: {symbol}")
        return market

    def _parse_addresses(self, market: ExchangeMarketConfig) -> dict[str, Pubkey | list[Pubkey]]:
        keys = self._exchange.keys
        return {
            "perp_asset_map": Pubkey.from_string(keys.perp_asset_map),
            "global_trader_index": [Pubkey.from_string(s) for s in keys.global_trader_index],
            "active_trader_buffer": [Pubkey.from_string(s) for s in keys.active_trader_buffer],
            "orderbook": Pubkey.from_string(market.market_pubkey),
            "spline_collection": Pubkey.from_string(market.spline_pubkey),
        }
