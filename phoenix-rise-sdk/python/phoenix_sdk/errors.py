from __future__ import annotations


class PhoenixError(Exception):
    """Base exception for Phoenix SDK."""


class PhoenixHttpError(PhoenixError):
    """Base for HTTP client errors."""


class RequestFailed(PhoenixHttpError):
    """HTTP request failed (network/transport error)."""


class ParseFailed(PhoenixHttpError):
    """Failed to parse API response."""

    def __init__(self, message: str, body: str | None = None):
        self.body = body
        super().__init__(message)


class ApiError(PhoenixHttpError):
    """API returned a non-2xx status."""

    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(f"API error: {status} - {message}")


class PhoenixWsError(PhoenixError):
    """Base for WebSocket client errors."""


class ConnectionFailed(PhoenixWsError):
    """WebSocket connection failed."""


class SubscriptionClosed(PhoenixWsError):
    """Subscription channel closed."""
