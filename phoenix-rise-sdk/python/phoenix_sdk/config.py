from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlparse, urlunparse

PHOENIX_API_URL_ENV = "PHOENIX_API_URL"
PHOENIX_WS_URL_ENV = "PHOENIX_WS_URL"
PHOENIX_API_KEY_ENV = "PHOENIX_API_KEY"

DEFAULT_PHOENIX_API_URL = "https://public-api.phoenix.trade"


def _derive_ws_url(api_url: str) -> str:
    """Derive a WebSocket URL from an HTTP API URL."""
    parsed = urlparse(api_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = parsed.path.rstrip("/")
    if not path.endswith("/ws"):
        path = path + "/ws"
    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


@dataclass
class PhoenixEnv:
    api_url: str
    api_key: str | None
    ws_url: str = field(default="")

    def __post_init__(self) -> None:
        if not self.ws_url:
            self.ws_url = _derive_ws_url(self.api_url)

    @classmethod
    def load(cls) -> PhoenixEnv:
        api_url = os.environ.get(PHOENIX_API_URL_ENV, DEFAULT_PHOENIX_API_URL)
        ws_url = os.environ.get(PHOENIX_WS_URL_ENV, "")
        return cls(
            api_url=api_url,
            api_key=os.environ.get(PHOENIX_API_KEY_ENV),
            ws_url=ws_url or _derive_ws_url(api_url),
        )
