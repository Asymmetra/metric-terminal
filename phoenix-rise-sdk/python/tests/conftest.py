import pytest

from phoenix_sdk import PhoenixHttpClient


@pytest.fixture
def client():
    return PhoenixHttpClient("https://api.test.com", "test-key")


@pytest.fixture
def public_client():
    return PhoenixHttpClient("https://api.test.com")
