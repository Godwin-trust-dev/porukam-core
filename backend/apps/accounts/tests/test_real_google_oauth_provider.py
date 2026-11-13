"""RealGoogleOAuthProvider — сетевой уровень изолирован моками
`httpx.post`/`httpx.get` (тесты никогда не ходят в реальный Google), см.
docs/tasks/Задача_feat_accounts-google-login-real.md §2.3. Тот же приём, что
`test_real_drive_oauth_provider.py`."""

from __future__ import annotations

import logging
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


_SECRETS = ("code-secret-1", "verifier-secret-1", "csecret", "at-secret", "user@example.test")


def _status_error(status: int, **kwargs) -> MagicMock:
    request = httpx.Request("POST", "https://oauth2.googleapis.com/token")
    response = httpx.Response(status, request=request, **kwargs)
    mock = MagicMock()
    mock.raise_for_status.side_effect = httpx.HTTPStatusError(
        str(status), request=request, response=response
    )
    return mock


def _complete_expecting_error():
    with pytest.raises(InvalidGoogleAuthorizationCodeError):
        _PROVIDER.complete(code="code-secret-1", code_verifier="verifier-secret-1")


def test_token_400_invalid_grant_is_logged_with_step(caplog):
    resp = _status_error(400, json={"error": "invalid_grant", "error_description": "Bad Request"})
    with (
        caplog.at_level(logging.WARNING, logger="apps.accounts.providers"),
        patch("apps.accounts.providers.httpx.post", return_value=resp),
    ):
        _complete_expecting_error()
    text = caplog.text
    assert "token" in text and "HTTP 400" in text
    assert "invalid_grant" in text and "Bad Request" in text


def test_token_401_invalid_client_is_logged(caplog):
    resp = _status_error(401, json={"error": "invalid_client"})
    with (
        caplog.at_level(logging.WARNING, logger="apps.accounts.providers"),
        patch("apps.accounts.providers.httpx.post", return_value=resp),
    ):
        _complete_expecting_error()
    assert "invalid_client" in caplog.text and "HTTP 401" in caplog.text


def test_token_non_json_body_is_truncated(caplog):
    resp = _status_error(502, text="x" * 500)
    with (
        caplog.at_level(logging.WARNING, logger="apps.accounts.providers"),
        patch("apps.accounts.providers.httpx.post", return_value=resp),
    ):
        _complete_expecting_error()
    assert "HTTP 502" in caplog.text
    assert "x" * 200 in caplog.text and "x" * 201 not in caplog.text


def test_network_error_logs_exception_type(caplog):
    with (
        caplog.at_level(logging.WARNING, logger="apps.accounts.providers"),
        patch(
            "apps.accounts.providers.httpx.post",
            side_effect=httpx.ConnectTimeout("boom csecret"),
        ),
    ):
        _complete_expecting_error()
    assert "ConnectTimeout" in caplog.text and "token" in caplog.text
    assert "csecret" not in caplog.text


def test_userinfo_failure_logged_with_step(caplog):
    token_response = MagicMock()
    token_response.raise_for_status.return_value = None
    token_response.json.return_value = {"access_token": "at-secret"}
    resp = _status_error(401, json={"error": "invalid_token"})
    with (
        caplog.at_level(logging.WARNING, logger="apps.accounts.providers"),
        patch("apps.accounts.providers.httpx.post", return_value=token_response),
        patch("apps.accounts.providers.httpx.get", return_value=resp),
    ):
        _complete_expecting_error()
    assert "userinfo" in caplog.text and "invalid_token" in caplog.text
    assert "at-secret" not in caplog.text


def test_missing_access_token_and_sub_email_logged_without_content(caplog):
    token_response = MagicMock()
    token_response.raise_for_status.return_value = None
    token_response.json.return_value = {"id_token": "idt-secret"}
    with (
        caplog.at_level(logging.WARNING, logger="apps.accounts.providers"),
        patch("apps.accounts.providers.httpx.post", return_value=token_response),
    ):
        _complete_expecting_error()
    assert "без access_token" in caplog.text
    assert "idt-secret" not in caplog.text

    caplog.clear()
    token_response.json.return_value = {"access_token": "at-secret"}
    userinfo_response = MagicMock()
    userinfo_response.raise_for_status.return_value = None
    userinfo_response.json.return_value = {"sub": "s1"}
    with (
        caplog.at_level(logging.WARNING, logger="apps.accounts.providers"),
        patch("apps.accounts.providers.httpx.post", return_value=token_response),
        patch("apps.accounts.providers.httpx.get", return_value=userinfo_response),
    ):
        _complete_expecting_error()
    assert "без sub/email" in caplog.text
    assert "at-secret" not in caplog.text


def test_no_secrets_in_log_even_if_google_echoes_them(caplog):
    # Google эхом возвращает чувствительные поля в теле — в лог идут только error/error_description.
    resp = _status_error(
        400,
        json={
            "error": "invalid_grant",
            "error_description": "Bad Request",
            "access_token": "at-secret",
            "id_token": "idt-secret",
            "refresh_token": "rt-secret",
            "email": "user@example.test",
        },
    )
    with (
        caplog.at_level(logging.DEBUG),
        patch("apps.accounts.providers.httpx.post", return_value=resp),
    ):
        _complete_expecting_error()
    for secret in (*_SECRETS, "idt-secret", "rt-secret"):
        assert secret not in caplog.text
