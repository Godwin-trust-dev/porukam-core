"""apps.contracts.api — Э4.4 приёмка (docs/tasks/etap-4.md): полный путь до
`signed` за обе стороны через Swagger-эквивалент (APIClient); подпись
устаревшего hash -> 409; правка после заморозки аннулирует подписи (видно в
timeline); Idempotency-Key на подписных POST."""

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


def _frozen_contract_setup(customer_phone: str, contractor_phone: str, trust_suffix: str):
    """draft -> under_review -> дерево этапов -> freeze, обоими клиентами."""
    customer_client = APIClient()
    customer = _login(customer_client, customer_phone)
    contractor = User.objects.create(
        trust_id=f"trust-signing-api-{trust_suffix}", phone=contractor_phone
    )
    contractor_profile = _person_profile(contractor)

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
    contract_id = resp.data["id"]

    contractor_client = APIClient()
    _login(contractor_client, contractor_phone)

    resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Работа", "amount": "10000.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze",
        format="json",
        HTTP_IDEMPOTENCY_KEY="freeze-key-1",
    )
    assert resp.status_code == 200, resp.content
    version_id = resp.data["id"]
    integrity_hash = resp.data["integrity_hash"]

    return (
        customer_client,
        contractor_client,
        contract_id,
        version_id,
        integrity_hash,
        customer,
        contractor,
    )


def test_full_signing_path_reaches_signed_for_both_sides():
    (
        customer_client,
        contractor_client,
        contract_id,
        version_id,
        integrity_hash,
        customer,
        contractor,
    ) = _frozen_contract_setup("+79990880001", "+79990880002", "1")

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-customer-1",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "contractor", "version_id": version_id, "signatory_user_id": str(contractor.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-contractor-1",
    )
    assert resp.status_code == 201, resp.content
    contractor_request_id = resp.data["id"]

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.data["negotiation_status"] == "awaiting_signatures"

    resp = customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-customer-1",
    )
    assert resp.status_code == 200, resp.content

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.data["negotiation_status"] == "awaiting_signatures"

    resp = contractor_client.post(
        f"/v1/signature-requests/{contractor_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-contractor-1",
    )
    assert resp.status_code == 200, resp.content

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "signed"


def test_sign_with_stale_hash_is_409():
    (
        customer_client,
        _contractor_client,
        contract_id,
        version_id,
        _integrity_hash,
        customer,
        _contractor,
    ) = _frozen_contract_setup("+79990880003", "+79990880004", "2")

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-customer-2",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/sign",
        {"version_hash": "0" * 64},
        format="json",
        HTTP_IDEMPOTENCY_KEY="sign-customer-stale",
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "version_stale"


def test_freeze_without_idempotency_key_is_400():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990880005")
    contractor = User.objects.create(trust_id="trust-signing-api-3", phone="+79990880006")
    contractor_profile = _person_profile(contractor)
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
    contract_id = resp.data["id"]
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Работа", "amount": "10000.00", "currency": "RUB"},
        format="json",
    )
    resp = customer_client.post(f"/v1/contracts/{contract_id}/freeze", format="json")
    assert resp.status_code == 400, resp.content
    assert resp.data["code"] == "idempotency_key_required"
    assert customer.id  # погашает F841-подобные линтеры на неиспользуемый customer


def test_freeze_idempotency_key_replay_returns_same_version_without_double_freezing():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990880007")
    contractor = User.objects.create(trust_id="trust-signing-api-4", phone="+79990880008")
    contractor_profile = _person_profile(contractor)
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
    contract_id = resp.data["id"]
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    customer_client.post(
        f"/v1/contracts/{contract_id}/milestones",
        {"title": "Работа", "amount": "10000.00", "currency": "RUB"},
        format="json",
    )

    resp1 = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze", format="json", HTTP_IDEMPOTENCY_KEY="replay-key"
    )
    assert resp1.status_code == 200, resp1.content

    resp2 = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze", format="json", HTTP_IDEMPOTENCY_KEY="replay-key"
    )
    assert resp2.status_code == 200, resp2.content
    assert resp1.data["id"] == resp2.data["id"]
    assert customer.id


def test_decline_for_revision_reopens_and_is_visible_in_timeline():
    (
        customer_client,
        contractor_client,
        contract_id,
        version_id,
        _integrity_hash,
        customer,
        contractor,
    ) = _frozen_contract_setup("+79990880009", "+79990880010", "5")

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-customer-5",
    )
    customer_request_id = resp.data["id"]

    resp = contractor_client.post(
        f"/v1/signature-requests/{customer_request_id}/decline",
        {"comment": "нужно поправить сумму"},
        format="json",
    )
    assert resp.status_code == 403, resp.content  # не адресат запроса

    resp = customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/decline",
        {"comment": "нужно поправить сумму"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "under_review"

    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    topics = [event["topic"] for event in resp.data]
    assert "negotiation.frozen" in topics
    assert "negotiation.signature_requested" in topics
    assert "negotiation.reopened" in topics
    reopened_event = next(e for e in resp.data if e["topic"] == "negotiation.reopened")
    assert reopened_event["payload"]["annulled_signature_request_ids"] == [customer_request_id]


def test_contract_exposes_frozen_version_id_after_freeze_and_clears_on_decline():
    """`frozen_version_id` в ContractSerializer — фронту больше не нужно
    выуживать id заморозки из timeline-события `negotiation.frozen`
    (SigningPage.tsx, ADR-088): после freeze поле = id версии, после
    decline_for_revision — снова null (services.py снимает `frozen_version`)."""
    (
        customer_client,
        _contractor_client,
        contract_id,
        version_id,
        _integrity_hash,
        customer,
        _contractor,
    ) = _frozen_contract_setup("+79990880011", "+79990880012", "6")

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 200, resp.content
    # ReadOnlyField отдаёт сырой UUID (в JSON он станет строкой) — сравниваем
    # через str с id из ответа /freeze (там UUIDField, уже строка).
    assert str(resp.data["frozen_version_id"]) == str(version_id)

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-customer-6",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/decline",
        {"comment": "нужно поправить сумму"},
        format="json",
    )
    assert resp.status_code == 200, resp.content

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["frozen_version_id"] is None


# --- ADR-124: return-for-revision / reject / withdraw на этапе подписания ---


def test_return_for_revision_endpoint_reopens_from_pending_signature():
    """Контрагент без заявки на подпись возвращает договор на доработку;
    событие `negotiation.reopened` с reason=returned_for_revision в timeline."""
    (
        customer_client,
        contractor_client,
        contract_id,
        _version_id,
        _integrity_hash,
        _customer,
        _contractor,
    ) = _frozen_contract_setup("+79990880013", "+79990880014", "7")

    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/return-for-revision", {"comment": ""}, format="json"
    )
    assert resp.status_code == 400, resp.content  # комментарий обязателен

    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/return-for-revision",
        {"comment": "нужно поправить сумму"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "under_review"
    assert resp.data["frozen_version_id"] is None

    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    reopened = next(e for e in resp.data if e["topic"] == "negotiation.reopened")
    assert reopened["payload"]["reason"] == "returned_for_revision"
    assert reopened["payload"]["comment"] == "нужно поправить сумму"

    # under_review — повторный возврат уже недопустим (409, общая FSM-ошибка).
    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/return-for-revision", {"comment": "ещё"}, format="json"
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "invalid_negotiation_transition"


def test_reject_and_withdraw_endpoints_work_from_awaiting_signatures():
    """reject — только контрагент (инициатору 403), withdraw — только
    инициатор; из awaiting_signatures заявка аннулируется."""
    (
        customer_client,
        contractor_client,
        contract_id,
        version_id,
        _integrity_hash,
        customer,
        _contractor,
    ) = _frozen_contract_setup("+79990880015", "+79990880016", "8")

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="route-customer-8",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = customer_client.post(f"/v1/contracts/{contract_id}/reject", format="json")
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "not_counterparty"
    resp = contractor_client.post(f"/v1/contracts/{contract_id}/withdraw", format="json")
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "not_initiator"

    resp = contractor_client.post(f"/v1/contracts/{contract_id}/reject", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "rejected_by_counterparty"
    assert resp.data["frozen_version_id"] is None

    resp = customer_client.get(f"/v1/signature-requests/{customer_request_id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "declined_for_revision"

    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    rejected = next(e for e in resp.data if e["topic"] == "negotiation.rejected")
    assert rejected["payload"]["annulled_signature_request_ids"] == [customer_request_id]


def test_withdraw_endpoint_from_pending_signature_by_initiator():
    (
        customer_client,
        _contractor_client,
        contract_id,
        _version_id,
        _integrity_hash,
        _customer,
        _contractor,
    ) = _frozen_contract_setup("+79990880017", "+79990880018", "9")

    resp = customer_client.post(f"/v1/contracts/{contract_id}/withdraw", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "withdrawn_by_initiator"
    assert resp.data["frozen_version_id"] is None
