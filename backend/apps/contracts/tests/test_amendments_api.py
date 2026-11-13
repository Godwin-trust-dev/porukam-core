"""apps.contracts.api — Э4.5 приёмка (docs/tasks/etap-4.md): допник
добавляет этап и меняет сумму — после подписания дерево обновилось,
происхождение этапа видно; допник, удаляющий принятый этап, -> 422. Через
APIClient (Swagger-эквивалент), тот же приём, что test_signing_api.py."""

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


def _sign_both_sides(
    customer_client, contractor_client, contract_id, customer, contractor, key_prefix
):
    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/freeze",
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"{key_prefix}-freeze",
    )
    assert resp.status_code == 200, resp.content
    version_id = resp.data["id"]
    integrity_hash = resp.data["integrity_hash"]

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"{key_prefix}-route-customer",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = contractor_client.post(
        f"/v1/contracts/{contract_id}/signature-requests",
        {"side": "contractor", "version_id": version_id, "signatory_user_id": str(contractor.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"{key_prefix}-route-contractor",
    )
    assert resp.status_code == 201, resp.content
    contractor_request_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"{key_prefix}-sign-customer",
    )
    assert resp.status_code == 200, resp.content

    resp = contractor_client.post(
        f"/v1/signature-requests/{contractor_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"{key_prefix}-sign-contractor",
    )
    assert resp.status_code == 200, resp.content


def _signed_contract_setup(customer_phone: str, contractor_phone: str, trust_suffix: str):
    """draft -> under_review -> дерево -> freeze -> обе подписи -> signed."""
    customer_client = APIClient()
    customer = _login(customer_client, customer_phone)
    contractor = User.objects.create(
        trust_id=f"trust-amendments-api-{trust_suffix}", phone=contractor_phone
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
    milestone_id = resp.data["id"]

    _sign_both_sides(
        customer_client,
        contractor_client,
        contract_id,
        customer,
        contractor,
        f"init-{trust_suffix}",
    )

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.data["negotiation_status"] == "signed"

    return customer_client, contractor_client, contract_id, milestone_id, customer, contractor


def test_amendment_adds_milestone_and_tree_updates_after_signing():
    """Приёмка Э4.5: допник добавляет этап и меняет сумму — после подписания
    дерево обновилось, происхождение этапа видно."""
    customer_client, contractor_client, contract_id, _milestone_id, customer, contractor = (
        _signed_contract_setup("+79990890001", "+79990890002", "1")
    )

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/amendments",
        {
            "reason": "Заказчик попросил доп. работы",
            "changes": [
                {
                    "type": "add_milestone",
                    "payload": {"title": "Доп. работа", "amount": "2500.00", "currency": "RUB"},
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-create-1",
    )
    assert resp.status_code == 201, resp.content
    amendment_id = resp.data["id"]
    assert resp.data["amount_delta"] == {"amount": "2500.00", "currency": "RUB"}

    resp = customer_client.post(f"/v1/amendments/{amendment_id}/send", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["negotiation_status"] == "under_review"

    resp = customer_client.post(
        f"/v1/amendments/{amendment_id}/freeze",
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-freeze-1",
    )
    assert resp.status_code == 200, resp.content
    version_id = resp.data["id"]
    integrity_hash = resp.data["integrity_hash"]

    resp = customer_client.post(
        f"/v1/amendments/{amendment_id}/signature-requests",
        {"side": "customer", "version_id": version_id, "signatory_user_id": str(customer.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-route-customer-1",
    )
    assert resp.status_code == 201, resp.content
    customer_request_id = resp.data["id"]

    resp = contractor_client.post(
        f"/v1/amendments/{amendment_id}/signature-requests",
        {"side": "contractor", "version_id": version_id, "signatory_user_id": str(contractor.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-route-contractor-1",
    )
    assert resp.status_code == 201, resp.content
    contractor_request_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/signature-requests/{customer_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-sign-customer-1",
    )
    assert resp.status_code == 200, resp.content

    resp = contractor_client.post(
        f"/v1/signature-requests/{contractor_request_id}/sign",
        {"version_hash": integrity_hash},
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-sign-contractor-1",
    )
    assert resp.status_code == 200, resp.content

    resp = customer_client.get(f"/v1/amendments/{amendment_id}")
    assert resp.data["negotiation_status"] == "signed"

    # Дерево обновилось, происхождение этапа видно.
    resp = customer_client.get(f"/v1/contracts/{contract_id}/milestones")
    assert resp.status_code == 200, resp.content
    titles = [node["title"] for node in resp.data]
    assert "Доп. работа" in titles

    from apps.milestones.models import Milestone

    new_milestone = Milestone.objects.get(title="Доп. работа")
    assert str(new_milestone.created_by_amendment_id) == amendment_id

    resp = customer_client.get(f"/v1/contracts/{contract_id}/effective-terms")
    assert resp.status_code == 200, resp.content
    assert resp.data["total_amount"]["amount"] == "12500.00"
    assert len(resp.data["amendments"]) == 1


def test_amendment_removing_accepted_milestone_is_422():
    """Приёмка Э4.5: допник, удаляющий принятый этап, -> 422."""
    customer_client, _contractor_client, contract_id, milestone_id, _customer, _contractor = (
        _signed_contract_setup("+79990890003", "+79990890004", "2")
    )

    from apps.milestones.models import Milestone

    milestone = Milestone.objects.get(pk=milestone_id)
    from django.utils import timezone

    milestone.accepted_at = timezone.now()
    milestone.save(update_fields=["accepted_at"])

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/amendments",
        {
            "reason": "Хотим убрать этап",
            "changes": [{"type": "remove_milestone", "target": milestone_id}],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-create-2",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "amendment_targets_accepted"


def test_amendment_on_unsigned_contract_is_409():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990890005")
    contractor = User.objects.create(trust_id="trust-amendments-api-3", phone="+79990890006")
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

    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/amendments",
        {"reason": "x", "changes": []},
        format="json",
        HTTP_IDEMPOTENCY_KEY="amendment-create-3",
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "contract_not_signed"
    assert customer.id
