"""API-уровень инкрементальной авторизации Drive (ADR-084). Тесты не ходят в
реальный Google — settings.EVIDENCE_DRIVE_PROVIDER дефолтится в "fake" во
всех окружениях, включая тесты (docs/tasks/Задача_feat_evidence-drive.md
§2.4), поэтому views сами собирают FakeGoogleDriveOAuthProvider."""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import SocialLoginAccount

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login_via_otp(client: APIClient, phone: str) -> dict:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    return resp.data


def _authed_client_with_google(phone: str, sub: str) -> APIClient:
    client = APIClient()
    tokens = _login_via_otp(client, phone)
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    from apps.accounts.models import User

    user = User.objects.get(phone=phone)
    SocialLoginAccount.objects.create(user=user, provider="google", sub=sub, email="a@x.com")
    return client


def test_drive_connect_status_false_before_connecting():
    client = _authed_client_with_google("+79990300001", "sub-api-1")
    resp = client.get("/v1/users/me/drive/connect")
    assert resp.status_code == 200, resp.content
    assert resp.data["connected"] is False


def test_drive_connect_authorize_url_requires_auth():
    client = APIClient()
    resp = client.get("/v1/users/me/drive/connect/authorize-url")
    assert resp.status_code == 401


def test_drive_connect_full_flow_marks_connected():
    client = _authed_client_with_google("+79990300002", "sub-api-2")

    resp = client.get("/v1/users/me/drive/connect/authorize-url")
    assert resp.status_code == 200, resp.content
    state = resp.data["state"]
    assert "drive.file" in resp.data["authorize_url"]

    resp = client.post(
        "/v1/users/me/drive/connect/callback",
        {"code": "code-api-2", "state": state},
        format="json",
    )
    assert resp.status_code == 200, resp.content

    resp = client.get("/v1/users/me/drive/connect")
    assert resp.data["connected"] is True


def test_drive_connect_callback_without_google_login_returns_409():
    client = APIClient()
    tokens = _login_via_otp(client, "+79990300003")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.get("/v1/users/me/drive/connect/authorize-url")
    state = resp.data["state"]

    resp = client.post(
        "/v1/users/me/drive/connect/callback",
        {"code": "code-x", "state": state},
        format="json",
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "drive_no_google_login"


def test_drive_connect_callback_invalid_state_returns_422():
    client = _authed_client_with_google("+79990300004", "sub-api-4")
    resp = client.post(
        "/v1/users/me/drive/connect/callback",
        {"code": "code-x", "state": "not-a-real-state"},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "drive_connect_state_invalid"


def test_drive_connect_disconnect_marks_not_connected():
    client = _authed_client_with_google("+79990300005", "sub-api-5")
    resp = client.get("/v1/users/me/drive/connect/authorize-url")
    state = resp.data["state"]
    client.post(
        "/v1/users/me/drive/connect/callback",
        {"code": "code-api-5", "state": state},
        format="json",
    )
    assert client.get("/v1/users/me/drive/connect").data["connected"] is True

    resp = client.delete("/v1/users/me/drive/connect")
    assert resp.status_code == 204, resp.content
    assert client.get("/v1/users/me/drive/connect").data["connected"] is False
