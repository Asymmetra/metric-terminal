from __future__ import annotations

from enum import Enum

from .core import Decimal, PhoenixModel, Side
from .market import RiskState, RiskTier


class TraderActivityState(str, Enum):
    UNINITIALIZED = "uninitialized"
    COLD = "cold"
    ACTIVE = "active"
    REDUCE_ONLY = "reduceOnly"
    FROZEN = "frozen"


class CapabilityAccess(PhoenixModel):
    immediate: bool = False
    via_cold_activation: bool = False


class TraderCapabilitiesView(PhoenixModel):
    place_limit_order: CapabilityAccess
    place_market_order: CapabilityAccess
    risk_increasing_trade: CapabilityAccess
    risk_reducing_trade: CapabilityAccess
    deposit_collateral: CapabilityAccess
    withdraw_collateral: CapabilityAccess


class TraderPositionView(PhoenixModel):
    symbol: str
    position_size: Decimal
    virtual_quote_position: Decimal
    entry_price: Decimal
    unrealized_pnl: Decimal
    discounted_unrealized_pnl: Decimal
    position_initial_margin: Decimal
    initial_margin: Decimal
    maintenance_margin: Decimal
    backstop_margin: Decimal
    limit_order_margin: Decimal
    position_value: Decimal
    unsettled_funding: Decimal
    accumulated_funding: Decimal
    liquidation_price: Decimal
    take_profit_price: Decimal | None = None
    stop_loss_price: Decimal | None = None


class LimitOrder(PhoenixModel):
    price: Decimal
    side: Side
    order_sequence_number: str
    initial_trade_size: Decimal
    trade_size_remaining: Decimal
    margin_requirement: Decimal
    margin_factor: Decimal
    is_reduce_only: bool
    is_stop_loss: bool = False


class TraderView(PhoenixModel):
    flags: int
    state: TraderActivityState
    capabilities: TraderCapabilitiesView
    trader_key: str
    trader_pda_index: int
    trader_subaccount_index: int
    authority: str
    collateral_balance: Decimal
    effective_collateral: Decimal
    effective_collateral_for_withdrawals: Decimal
    unrealized_pnl: Decimal
    discounted_unrealized_pnl: Decimal
    unsettled_funding_owed: Decimal
    accumulated_funding: Decimal
    portfolio_value: Decimal
    maintenance_margin: Decimal
    cancel_margin: Decimal
    initial_margin: Decimal
    initial_margin_for_withdrawals: Decimal
    risk_state: RiskState
    risk_tier: RiskTier
    positions: list[TraderPositionView]
    limit_orders: dict[str, list[LimitOrder]]
    maker_fee_override_multiplier: float
    taker_fee_override_multiplier: float
    max_positions: int
    last_deposit_slot: int
    is_in_active_traders: bool


class TraderStateResponse(PhoenixModel):
    slot: int
    slot_index: int
    authority: str
    pda_index: int
    traders: list[TraderView]
