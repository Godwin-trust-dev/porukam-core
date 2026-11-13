"""Google OAuth — второй способ входа (ГВ.2, docs/tasks/global-wave.md,
ADR-071). Уровень services.py — state+PKCE и связка sub↔User напрямую, без
HTTP (симметрично apps/identity/tests, но для входа, не верификации)."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts import services
from apps.accounts.models import SocialLoginAccount, User
from apps.accounts.providers import FakeGoogleOAuthProvider

pytestmark = pytest.mark.django_db

_PROVIDER = FakeGoogleOAuthProvider()


def test_build_authorize_url_does_not_require_a_user():
    """В отличие от ESIA (ADR-062) вход анонимный — на этом шаге ещё нет
    пользователя, которому мог бы принадлежать state."""
    url, state = services.build_google_authorize_url(provider=_PROVIDER)
    assert state in url or "state=" in url
    assert state


def test_complete_google_login_first_time_creates_user_and_issues_tokens():
    _url, state = services.build_google_authorize_url(provider=_PROVIDER)

    user, tokens, created = services.complete_google_login(
        code="sub-001|first@example.test", state=state, provider=_PROVIDER
    )

    assert created is True
    assert user.email == "first@example.test"
    assert user.phone is None  # GLOBAL-профиль: телефон опционален (ГВ.1)
    assert user.verification_level == User.VerificationLevel.BASIC
    assert tokens.access and tokens.refresh
    link = SocialLoginAccount.objects.get(provider=_PROVIDER.provider_code, sub="sub-001")
    assert link.user_id == user.id
    assert link.email == "first@example.test"


def test_complete_google_login_same_sub_returns_same_user():
    _url, state1 = services.build_google_authorize_url(provider=_PROVIDER)
    user1, _tokens1, created1 = services.complete_google_login(
        code="sub-002|second@example.test", state=state1, provider=_PROVIDER
    )

    _url, state2 = services.build_google_authorize_url(provider=_PROVIDER)
    user2, _tokens2, created2 = services.complete_google_login(
        code="sub-002|second@example.test", state=state2, provider=_PROVIDER
    )

    assert created1 is True
    assert created2 is False
    assert user1.id == user2.id


def test_complete_google_login_refreshes_link_email_but_not_user_email():
    """email — обновляемый атрибут связки (SocialLoginAccount), не
    User.email напрямую: повторный вход с другой почтой на стороне Google
    не должен молча перезаписывать то, что пользователь мог указать сам
    через PATCH /users/me."""
    _url, state1 = services.build_google_authorize_url(provider=_PROVIDER)
    user1, _tokens1, _created1 = services.complete_google_login(
        code="sub-003|old@example.test", state=state1, provider=_PROVIDER
    )

    _url, state2 = services.build_google_authorize_url(provider=_PROVIDER)
    user2, _tokens2, _created2 = services.complete_google_login(
        code="sub-003|new@example.test", state=state2, provider=_PROVIDER
    )

    assert user1.id == user2.id
    link = SocialLoginAccount.objects.get(provider=_PROVIDER.provider_code, sub="sub-003")
    assert link.email == "new@example.test"
    user2.refresh_from_db()
    assert user2.email == "old@example.test"


def test_complete_google_login_leaves_email_unset_on_conflict():
    """Почта Google уже занята другим User — регистрация не падает,
    профиль просто остаётся без почты (PATCH /users/me — self-service)."""
    User.objects.create(trust_id="trust-taken-email", email="taken@example.test")

    _url, state = services.build_google_authorize_url(provider=_PROVIDER)
    user, _tokens, created = services.complete_google_login(
        code="sub-004|taken@example.test", state=state, provider=_PROVIDER
    )

    assert created is True
    assert user.email is None


def test_complete_google_login_with_unknown_state_is_rejected():
    with pytest.raises(services.GoogleOAuthStateInvalidError):
        services.complete_google_login(
            code="sub-005|x@example.test", state="unknown-state", provider=_PROVIDER
        )


def test_complete_google_login_state_is_one_shot():
    _url, state = services.build_google_authorize_url(provider=_PROVIDER)
    services.complete_google_login(code="sub-006|a@example.test", state=state, provider=_PROVIDER)
    with pytest.raises(services.GoogleOAuthStateInvalidError):
        services.complete_google_login(
            code="sub-006|a@example.test", state=state, provider=_PROVIDER
        )


def test_complete_google_login_with_malformed_code_is_rejected():
    _url, state = services.build_google_authorize_url(provider=_PROVIDER)
    with pytest.raises(services.GoogleOAuthCodeInvalidError):
        services.complete_google_login(code="not-a-valid-code", state=state, provider=_PROVIDER)


# --- API (Swagger-совместимый флоу, ✅ ГВ.1/ГВ.2 приёмка) ---


def _google_login(client: APIClient, *, sub: str, email: str) -> dict:
    resp = client.get("/v1/auth/google/authorize-url")
    assert resp.status_code == 200, resp.content
    state = resp.data["state"]
    resp = client.post(
        "/v1/auth/google/callback", {"code": f"{sub}|{email}", "state": state}, format="json"
    )
    assert resp.status_code == 200, resp.content
    return resp.data


def test_full_fake_google_login_flow_via_api_issues_tokens():
    client = APIClient()
    tokens = _google_login(client, sub="api-sub-001", email="api1@example.test")
    assert "access" in tokens and "refresh" in tokens

    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    me = client.get("/v1/users/me")
    assert me.status_code == 200
    assert me.data["email"] == "api1@example.test"
    assert "trust_id" not in me.data


def test_api_repeat_login_same_sub_is_same_user():
    client = APIClient()
    tokens1 = _google_login(client, sub="api-sub-002", email="api2@example.test")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens1['access']}")
    me1 = client.get("/v1/users/me").data

    client2 = APIClient()
    tokens2 = _google_login(client2, sub="api-sub-002", email="api2@example.test")
    client2.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens2['access']}")
    me2 = client2.get("/v1/users/me").data

    assert me1["id"] == me2["id"]


def test_api_google_callback_with_invalid_code_is_422_problem_json():
    client = APIClient()
    resp = client.get("/v1/auth/google/authorize-url")
    state = resp.data["state"]
    resp = client.post(
        "/v1/auth/google/callback", {"code": "garbage", "state": state}, format="json"
    )
    assert resp.status_code == 422
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "google_oauth_code_invalid"


def test_api_google_callback_with_unknown_state_is_422_problem_json():
    client = APIClient()
    resp = client.post(
        "/v1/auth/google/callback",
        {"code": "sub|e@example.test", "state": "does-not-exist"},
        format="json",
    )
    assert resp.status_code == 422
    assert resp.data["code"] == "google_oauth_state_invalid"


def test_api_google_authorize_url_does_not_require_authentication():
    client = APIClient()
    resp = client.get("/v1/auth/google/authorize-url")
    assert resp.status_code == 200
