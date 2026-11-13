"""RealGoogleOAuthProvider — сетевой уровень изолирован моками
`httpx.post`/`httpx.get` (тесты никогда не ходят в реальный Google), см.
docs/tasks/Задача_feat_accounts-google-login-real.md §2.3. Тот же приём, что
`test_real_drive_oauth_provider.py`."""

from __future__ import annotations

from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from apps.accounts.providers import InvalidGoogleAuthorizationCodeError, RealGoogleOAuthProvider

_PROVIDER = RealGoogleOAuthProvider(
    client_id="cid",
    client_secret="csecret",
    redirect_uri="https://app.example/auth/google/callback",
)


def test_authorize_url_uses_openid_email_profile_scope_and_pkce():
    url = _PROVIDER.authorize_url(state="st1", code_challenge="ch1")
    query = parse_qs(urlparse(url).query)
    assert query["scope"] == ["openid email profile"]
    assert query["client_id"] == ["cid"]
    assert query["redirect_uri"] == ["https://app.example/auth/google/callback"]
    assert query["code_challenge"] == ["ch1"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == ["st1"]
    assert query["access_type"] == ["online"]  # логину refresh-токен не нужен
    # Красная линия ADR-084: никакого drive-scope в логине.
    assert "drive" not in query["scope"][0]


def test_complete_returns_identity_from_token_exchange_and_userinfo():
    token_response = MagicMock()
    token_response.raise_for_status.return_value = None
    token_response.json.return_value = {"access_token": "at-1"}
    userinfo_response = MagicMock()
    userinfo_response.raise_for_status.return_value = None
    userinfo_response.json.return_value = {"sub": "sub-1", "email": "user@example.test"}

    with (
        patch("apps.accounts.providers.httpx.post", return_value=token_response) as mock_post,
        patch("apps.accounts.providers.httpx.get", return_value=userinfo_response) as mock_get,
    ):
        identity = _PROVIDER.complete(code="code-1", code_verifier="verifier-1")

    assert identity.sub == "sub-1"
    assert identity.email == "user@example.test"
    # PKCE реально ушёл в обмен (не мёртвый кешируемый verifier).
    assert mock_post.call_args.kwargs["data"]["code_verifier"] == "verifier-1"
    assert mock_get.call_args.kwargs["headers"]["Authorization"] == "Bearer at-1"


def test_complete_raises_when_token_exchange_fails():
    request = httpx.Request("POST", "https://oauth2.googleapis.com/token")
    response = httpx.Response(400, json={"error": "invalid_grant"}, request=request)
    error = httpx.HTTPStatusError("400", request=request, response=response)
    token_response = MagicMock()
    token_response.raise_for_status.side_effect = error
    with (
        patch("apps.accounts.providers.httpx.post", return_value=token_response),
        pytest.raises(InvalidGoogleAuthorizationCodeError),
    ):
        _PROVIDER.complete(code="bad-code", code_verifier="verifier-1")


def test_complete_raises_when_userinfo_missing_sub_or_email():
    token_response = MagicMock()
    token_response.raise_for_status.return_value = None
    token_response.json.return_value = {"access_token": "at-1"}
    userinfo_response = MagicMock()
    userinfo_response.raise_for_status.return_value = None
    userinfo_response.json.return_value = {"sub": "sub-1"}  # без email

    with (
        patch("apps.accounts.providers.httpx.post", return_value=token_response),
        patch("apps.accounts.providers.httpx.get", return_value=userinfo_response),
        pytest.raises(InvalidGoogleAuthorizationCodeError),
    ):
        _PROVIDER.complete(code="code-1", code_verifier="verifier-1")
