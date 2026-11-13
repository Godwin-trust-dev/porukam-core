"""apps.contracts.api — Э4.2 приёмка (docs/tasks/etap-4.md): полный
пинг-понг правок двумя мок-пользователями через Swagger (здесь — через
APIClient); accept-all без confirm_summary при денежной правке -> 422;
timeline показывает всю историю."""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> User:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
    return User.objects.get(phone=phone)


def _person_profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


def _create_draft_contract(customer_client: APIClient, contractor_profile: Profile) -> str:
    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
            "title": "Ремонт крана",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    return str(resp.data["id"])


def _two_sided_setup(customer_phone: str, contractor_phone: str, trust_suffix: str):
    customer_client = APIClient()
    _login(customer_client, customer_phone)
    contractor = User.objects.create(
        trust_id=f"trust-negotiation-api-{trust_suffix}", phone=contractor_phone
    )
    contractor_profile = _person_profile(contractor)
    contract_id = _create_draft_contract(customer_client, contractor_profile)

    contractor_client = APIClient()
    _login(contractor_client, contractor_phone)
    return customer_client, contractor_client, contract_id


def test_full_ping_pong_through_swagger_equivalent_flow():
    customer_client, contractor_client, contract_id = _two_sided_setup(
        "+79990870001", "+79990870002", "1"
    )

    resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "under_review"

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/revisions",
        {"item_ref": "title", "new_value": "Ремонт крана, вариант А"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    proposal_id = resp.data["id"]
    assert resp.data["status"] == "open"

    resp = contractor_client.post(
        f"/v1/revisions/{proposal_id}/counter",
        {"new_value": "Ремонт крана, вариант Б"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    counter_id = resp.data["id"]
    assert resp.data["status"] == "open"
    assert resp.data["old_value"] == "Ремонт крана, вариант А"

    resp = customer_client.post(f"/v1/revisions/{counter_id}/accept", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "accepted"

    resp = customer_client.get(f"/v1/contracts/{contract_id}/revisions")
    assert resp.status_code == 200, resp.content
    statuses = {p["id"]: p["status"] for p in resp.data}
    assert statuses[proposal_id] == "superseded"
    assert statuses[counter_id] == "accepted"


def test_accept_all_without_confirm_summary_on_money_change_is_422():
    customer_client, contractor_client, contract_id = _two_sided_setup(
        "+79990870003", "+79990870004", "2"
    )
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    contractor_client.post(
        f"/v1/contracts/{contract_id}/revisions",
        {
            "item_ref": "milestones[0].amount",
            "new_value": {"amount": "5000.00", "currency": "RUB"},
        },
        format="json",
    )

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/revisions/accept-all", {}, format="json"
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "confirm_summary_required"
    assert resp.data["context"]["summary"][0]["item_ref"] == "milestones[0].amount"

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/revisions/accept-all",
        {"confirm_summary": True},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data[0]["status"] == "accepted"


def test_withdraw_by_initiator_then_reject_is_no_longer_possible():
    customer_client, contractor_client, contract_id = _two_sided_setup(
        "+79990870005", "+79990870006", "3"
    )
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    resp = customer_client.post(f"/v1/contracts/{contract_id}/withdraw", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "withdrawn_by_initiator"

    resp = contractor_client.post(f"/v1/contracts/{contract_id}/reject", format="json")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "invalid_negotiation_transition"


def test_withdraw_by_counterparty_is_403():
    customer_client, contractor_client, contract_id = _two_sided_setup(
        "+79990870007", "+79990870008", "4"
    )
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    resp = contractor_client.post(f"/v1/contracts/{contract_id}/withdraw", format="json")
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "not_initiator"


def test_timeline_shows_full_history():
    customer_client, contractor_client, contract_id = _two_sided_setup(
        "+79990870009", "+79990870010", "5"
    )
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/revisions",
        {"item_ref": "title", "new_value": "Вариант А"},
        format="json",
    )
    proposal_id = resp.data["id"]
    contractor_client.post(f"/v1/revisions/{proposal_id}/accept", format="json")

    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    topics = [event["topic"] for event in resp.data]
    assert topics == [
        "contract.drafted",
        "negotiation.sent",
        "negotiation.revised",
        "negotiation.revised",
    ]


def test_preapproved_alternative_apply_in_one_click():
    customer_client, contractor_client, contract_id = _two_sided_setup(
        "+79990870011", "+79990870012", "6"
    )
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/preapproved-alternatives",
        {"item_ref": "payment_method", "payload": {"payment_method": "external"}},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    alternative_id = resp.data["id"]

    resp = contractor_client.post(
        f"/v1/preapproved-alternatives/{alternative_id}/apply", format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "accepted"
    assert str(resp.data["preapproved_alternative_of_id"]) == alternative_id
