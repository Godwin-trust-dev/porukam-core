import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway

pytestmark = pytest.mark.django_db


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> dict:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
    return resp.data


def _authorize_url_and_state(client: APIClient) -> tuple[str, str]:
    resp = client.get("/v1/auth/esia/authorize-url")
    assert resp.status_code == 200, resp.content
    return resp.data["authorize_url"], resp.data["state"]


def test_esia_authorize_url_requires_authentication():
    client = APIClient()
    resp = client.get("/v1/auth/esia/authorize-url")
    assert resp.status_code == 401


def test_esia_authorize_url_returns_url_and_state():
    client = APIClient()
    _login(client, "+79990500001")
    url, state = _authorize_url_and_state(client)
    assert url.startswith("https://esia.gosuslugi.ru/")
    assert state


def test_full_esia_verification_flow_updates_users_me():
    client = APIClient()
    _login(client, "+79990500002")

    _url, state = _authorize_url_and_state(client)
    callback = client.post(
        "/v1/auth/esia/callback",
        {"code": "Пётр Петров|7701234567", "state": state},
        format="json",
    )
    assert callback.status_code == 200, callback.content
    assert callback.data["status"] == "succeeded"

    me = client.get("/v1/users/me")
    assert me.status_code == 200
    assert me.data["verification_level"] == "verified"
    assert "trust_id" not in me.data


def test_esia_callback_with_invalid_code_is_422():
    client = APIClient()
    _login(client, "+79990500003")
    _url, state = _authorize_url_and_state(client)

    resp = client.post(
        "/v1/auth/esia/callback", {"code": "not-a-valid-code", "state": state}, format="json"
    )
    assert resp.status_code == 422
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "esia_code_invalid"


def test_esia_callback_with_unknown_state_is_422():
    client = APIClient()
    _login(client, "+79990500004")

    resp = client.post(
        "/v1/auth/esia/callback",
        {"code": "Имя Фамильев|7701234567", "state": "unknown-state"},
        format="json",
    )
    assert resp.status_code == 422
    assert resp.data["code"] == "esia_state_invalid"


def test_verification_gate_demo_403_before_verification_then_200_after():
    client = APIClient()
    _login(client, "+79990500005")

    before = client.get("/v1/identity/verification-gate-demo")
    assert before.status_code == 403
    assert before["Content-Type"].startswith("application/problem+json")
    assert before.data["code"] == "verification_required"
    assert before.data["context"]["required_level"] == "verified"

    _url, state = _authorize_url_and_state(client)
    client.post(
        "/v1/auth/esia/callback",
        {"code": "Мария Сидорова|7701234568", "state": state},
        format="json",
    )

    after = client.get("/v1/identity/verification-gate-demo")
    assert after.status_code == 200
    assert after.data == {"ok": True}
