from __future__ import annotations

from .core import JsSafeU64, PhoenixModel
from .market import MarketStatus


class AuthoritySetView(PhoenixModel):
    root_authority: str
    risk_authority: str
    market_authority: str
    oracle_authority: str


class ExchangeKeysView(PhoenixModel):
    global_config: str
    current_authorities: AuthoritySetView
    pending_authorities: AuthoritySetView
    canonical_mint: str
    global_vault: str
    perp_asset_map: str
    global_trader_index: list[str]
    active_trader_buffer: list[str]
    withdraw_queue: str


class ExchangeLeverageTier(PhoenixModel):
    max_leverage: float
    max_size_base_lots: int
    limit_order_risk_factor: float


class ExchangeRiskFactors(PhoenixModel):
    maintenance: float
    backstop: float
    high_risk: float
    upnl: float
    upnl_for_withdrawals: float
    cancel_order: float


class ExchangeMarketConfig(PhoenixModel):
    symbol: str
    asset_id: int
    market_status: MarketStatus
    market_pubkey: str
    spline_pubkey: str
    tick_size: int
    base_lots_decimals: int
    taker_fee: float
    maker_fee: float
    leverage_tiers: list[ExchangeLeverageTier]
    risk_factors: ExchangeRiskFactors
    funding_interval_seconds: int
    funding_period_seconds: int
    max_funding_rate_per_interval: float
    open_interest_cap_base_lots: JsSafeU64
    max_liquidation_size_base_lots: JsSafeU64
    isolated_only: bool


class ExchangeResponse(PhoenixModel):
    keys: ExchangeKeysView
    markets: list[ExchangeMarketConfig]
