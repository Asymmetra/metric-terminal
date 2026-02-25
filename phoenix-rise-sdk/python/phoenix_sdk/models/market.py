from enum import Enum


class MarketStatus(str, Enum):
    UNINITIALIZED = "uninitialized"
    ACTIVE = "active"
    POST_ONLY = "postOnly"
    PAUSED = "paused"
    CLOSED = "closed"
    TOMBSTONED = "tombstoned"


class RiskState(str, Enum):
    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    UNDERWATER = "underwater"
    ZERO_COLLATERAL_NO_POSITIONS = "zeroCollateralNoPositions"


class RiskTier(str, Enum):
    SAFE = "safe"
    AT_RISK = "atRisk"
    CANCELLABLE = "cancellable"
    LIQUIDATABLE = "liquidatable"
    BACKSTOP_LIQUIDATABLE = "backstopLiquidatable"
    HIGH_RISK = "highRisk"
