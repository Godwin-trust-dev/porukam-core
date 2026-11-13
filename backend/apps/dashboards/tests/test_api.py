"""GET /v1/dashboard (ADR-090) — тонкая обёртка над selectors.get_dashboard,
здесь проверяется только HTTP-слой (auth/wiring), доменная логика —
apps/dashboards/tests/test_selectors.py. Без параметров (ADR-090 §4)."""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.contracts.tests._signing_helpers import make_frozen_contract, route_both_sides

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


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


def test_dashboard_requires_authentication():
    client = APIClient()
    resp = client.get("/v1/dashboard")
    assert resp.status_code == 401


def test_dashboard_empty_for_fresh_user():
    client = APIClient()
    _login(client, "+79990950301")
    resp = client.get("/v1/dashboard")
    assert resp.status_code == 200, resp.content
    assert resp.data == {"attention": []}


def test_dashboard_lists_pending_signature_as_attention():
    client = APIClient()
    _login(client, "+79990950302")
    customer = User.objects.get(phone="+79990950302")
    contractor = User.objects.create(trust_id="trust-dash-api-ctr", phone="+79990950303")
    contract = make_frozen_contract(customer=customer, contractor=contractor)
    route_both_sides(
        contract, customer=customer, contractor=contractor, version_id=contract.frozen_version_id
    )

    resp = client.get("/v1/dashboard")

    assert resp.status_code == 200, resp.content
    assert [i["kind"] for i in resp.data["attention"]] == ["signature"]
    assert resp.data["attention"][0]["contract_id"] == str(contract.id)
    assert resp.data["attention"][0]["side"] == "customer"
