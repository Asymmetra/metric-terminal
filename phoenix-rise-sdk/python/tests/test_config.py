import os

from phoenix_sdk.config import (
    DEFAULT_PHOENIX_API_URL,
    PHOENIX_API_KEY_ENV,
    PHOENIX_API_URL_ENV,
    PhoenixEnv,
)


def test_load_defaults(monkeypatch):
    monkeypatch.delenv(PHOENIX_API_URL_ENV, raising=False)
    monkeypatch.delenv(PHOENIX_API_KEY_ENV, raising=False)
    env = PhoenixEnv.load()
    assert env.api_url == DEFAULT_PHOENIX_API_URL
    assert env.api_key is None


def test_load_from_env(monkeypatch):
    monkeypatch.setenv(PHOENIX_API_URL_ENV, "https://custom.api.com")
    monkeypatch.setenv(PHOENIX_API_KEY_ENV, "my-secret-key")
    env = PhoenixEnv.load()
    assert env.api_url == "https://custom.api.com"
    assert env.api_key == "my-secret-key"
