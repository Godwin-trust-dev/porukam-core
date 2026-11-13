"""RealGoogleDriveOAuthProvider — сетевой уровень изолирован моком
`httpx.post` (тесты никогда не ходят в реальный Google)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from apps.accounts.providers import (
    GoogleDriveGrantInvalidError,
    InvalidGoogleDriveAuthorizationCodeError,
    RealGoogleDriveOAuthProvider,
)

_PROVIDER = RealGoogleDriveOAuthProvider(
    client_id="cid", client_secret="csecret", redirect_uri="https://app.example/callback"
)


def test_connect_authorize_url_uses_drive_file_scope_offline_and_consent():
    url = _PROVIDER.connect_authorize_url(state="st1", code_challenge="ch1")
    assert "scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file" in url
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "client_id=cid" in url
    # Красная линия ADR-084: широкий scope никогда не попадает в URL.
    assert "auth/drive.readonly" not in url
    assert "auth%2Fdrive&" not in url


def test_exchange_code_returns_tokens():
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None
    mock_response.json.return_value = {
        "access_token": "at-1",
        "refresh_token": "rt-1",
        "expires_in": 3600,
    }
    with patch("apps.accounts.providers.httpx.post", return_value=mock_response):
        tokens = _PROVIDER.exchange_code(code="code-1", code_verifier="verifier-1")
    assert tokens.access_token == "at-1"
    assert tokens.refresh_token == "rt-1"


def test_exchange_code_without_refresh_token_raises():
    """Google не вернул refresh_token — offline-доступа не было (не должно
    случаться при prompt=consent, но не должно тихо проглатываться)."""
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None
    mock_response.json.return_value = {"access_token": "at-1", "expires_in": 3600}
    with (
        patch("apps.accounts.providers.httpx.post", return_value=mock_response),
        pytest.raises(InvalidGoogleDriveAuthorizationCodeError),
    ):
        _PROVIDER.exchange_code(code="code-1", code_verifier="verifier-1")


def test_refresh_access_token_success():
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None
    mock_response.json.return_value = {"access_token": "at-refreshed"}
    with patch("apps.accounts.providers.httpx.post", return_value=mock_response):
        token = _PROVIDER.refresh_access_token(refresh_token="rt-1")
    assert token == "at-refreshed"


def test_refresh_access_token_invalid_grant_raises_typed_error():
    request = httpx.Request("POST", "https://oauth2.googleapis.com/token")
    response = httpx.Response(400, json={"error": "invalid_grant"}, request=request)
    error = httpx.HTTPStatusError("400", request=request, response=response)
    mock_response = MagicMock()
    mock_response.raise_for_status.side_effect = error
    with (
        patch("apps.accounts.providers.httpx.post", return_value=mock_response),
        pytest.raises(GoogleDriveGrantInvalidError),
    ):
        _PROVIDER.refresh_access_token(refresh_token="revoked-token")
