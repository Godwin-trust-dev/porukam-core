"""apps.contracts.api — Э4.1 приёмка (docs/tasks/etap-4.md): создать
черновик «Услуга» с исполнителем-физлицом -> services_individual/free_c2c;
тот же флоу с исполнителем-СМЗ -> services_business; «Продажа» с
предметом-авто -> 409 not_yet_supported."""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

from apps.accounts import services as accounts_services
from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.contracts.models import Contract, ContractParty
from apps.profiles.models import Profile
from common.models import OutboxEvent

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


def test_create_draft_service_with_individual_contractor_is_free_c2c():
    customer_client = APIClient()
    _login(customer_client, "+79990860001")
    contractor = User.objects.create(trust_id="trust-contracts-api-1", phone="+79990860002")
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
    assert resp.data["contract_type_code"] == "services_individual"
    assert resp.data["segment"] == "free_c2c"
    assert resp.data["negotiation_status"] == "draft"
    assert len(resp.data["parties"]) == 2
    # docs/tasks/Задача_redesign_contracts-execution-flow-real-api.md, ADR-088
    # («Фаза 0»): total/initiator_role — новые поля ContractSerializer.
    assert resp.data["total"] is None  # ни одного этапа ещё нет
    assert resp.data["initiator_role"] == "customer"  # создал заказчик
    assert resp.data["frozen_version_id"] is None  # заморозки ещё не было


def test_contract_total_is_leaf_sum_after_milestone_created():
    """total (ADR-088) — не поле, а `total_leaf_amount`: появляется, как
    только у договора есть хотя бы один лист, и растёт вместе с деревом."""
    from apps.contracts.models import Contract
    from apps.milestones import services as milestones_services

    customer_client = APIClient()
    customer = _login(customer_client, "+79990860011")
    contractor = User.objects.create(trust_id="trust-contracts-api-total-1", phone="+79990860012")
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    contract = Contract.objects.get(pk=resp.data["id"])

    milestones_services.create_milestone(
        contract, user=customer, title="Этап 1", amount="1500.00", currency="RUB"
    )
    milestones_services.create_milestone(
        contract, user=customer, title="Этап 2", amount="500.00", currency="RUB"
    )

    resp = customer_client.get(f"/v1/contracts/{contract.id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["total"] == {"amount": "2000.00", "currency": "RUB"}


def test_create_draft_service_with_smz_contractor_is_paid_business():
    customer_client = APIClient()
    _login(customer_client, "+79990860003")
    contractor = User.objects.create(trust_id="trust-contracts-api-2", phone="+79990860004")
    accounts_services.set_business_status(contractor, True)
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "payment_order": "after_acceptance",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["contract_type_code"] == "services_business"
    assert resp.data["segment"] == "paid_business"


def test_create_draft_sale_vehicle_is_409_not_yet_supported():
    customer_client = APIClient()
    _login(customer_client, "+79990860005")
    contractor = User.objects.create(trust_id="trust-contracts-api-3", phone="+79990860006")
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "sale_vehicle",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
        },
        format="json",
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "not_yet_supported"


def test_create_draft_excluded_type_is_403():
    customer_client = APIClient()
    _login(customer_client, "+79990860007")
    contractor = User.objects.create(trust_id="trust-contracts-api-4", phone="+79990860008")
    contractor_profile = _person_profile(contractor)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "shares_securities",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
        },
        format="json",
    )
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "contract_type_excluded"


def test_create_draft_without_type_or_counterparty_is_400():
    customer_client = APIClient()
    _login(customer_client, "+79990860009")
    resp = customer_client.post("/v1/contracts", {"my_role": "customer"}, format="json")
    assert resp.status_code == 400, resp.content


def test_get_contract_requires_being_a_party():
    customer_client = APIClient()
    _login(customer_client, "+79990860010")
    contractor = User.objects.create(trust_id="trust-contracts-api-5", phone="+79990860011")
    contractor_profile = _person_profile(contractor)
    create_resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "loan_individuals",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
        },
        format="json",
    )
    contract_id = create_resp.data["id"]

    stranger_client = APIClient()
    _login(stranger_client, "+79990860012")
    resp = stranger_client.get(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 403, resp.content

    own_resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert own_resp.status_code == 200, own_resp.content


def test_patch_draft_updates_title():
    customer_client = APIClient()
    _login(customer_client, "+79990860013")
    contractor = User.objects.create(trust_id="trust-contracts-api-6", phone="+79990860014")
    contractor_profile = _person_profile(contractor)
    create_resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "loan_individuals",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "title": "Заём",
        },
        format="json",
    )
    contract_id = create_resp.data["id"]

    resp = customer_client.patch(
        f"/v1/contracts/{contract_id}", {"title": "Заём на инструмент"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["title"] == "Заём на инструмент"


def test_list_my_contracts_filters_by_role():
    customer_client = APIClient()
    _login(customer_client, "+79990860015")
    contractor = User.objects.create(trust_id="trust-contracts-api-7", phone="+79990860016")
    contractor_profile = _person_profile(contractor)
    customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "loan_individuals",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
        },
        format="json",
    )

    resp = customer_client.get("/v1/contracts", {"role": "customer"})
    assert resp.status_code == 200, resp.content
    assert len(resp.data) == 1

    resp = customer_client.get("/v1/contracts", {"role": "contractor"})
    assert resp.status_code == 200, resp.content
    assert len(resp.data) == 0


# --- DELETE /contracts/{id}: удаление черновика ------------------------------


def _draft_with_counterparty(
    customer_phone: str, contractor_phone: str, tag: str
) -> tuple[APIClient, APIClient, str]:
    customer_client = APIClient()
    _login(customer_client, customer_phone)
    contractor_client = APIClient()
    contractor_user = _login(contractor_client, contractor_phone)
    contractor_profile = _person_profile(contractor_user)
    create_resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "loan_individuals",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            # send требует способ расчёта (PaymentMethodRequiredError) —
            # как и реальный мастер, задаём его ещё в черновике.
            "payment_method": "cash",
            "title": f"Черновик {tag}",
        },
        format="json",
    )
    assert create_resp.status_code == 201, create_resp.content
    return customer_client, contractor_client, create_resp.data["id"]


def test_delete_draft_by_author_is_204_and_cascades():
    customer_client, _contractor_client, contract_id = _draft_with_counterparty(
        "+79990860021", "+79990860022", "del-1"
    )

    resp = customer_client.delete(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 204, resp.content
    assert not Contract.objects.filter(id=contract_id).exists()
    assert not ContractParty.objects.filter(contract_id=contract_id).exists()
    assert OutboxEvent.objects.filter(
        topic="contract.draft_deleted", subject__id=str(contract_id)
    ).exists()

    resp = customer_client.get(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 404


def test_delete_draft_by_counterparty_is_204():
    _customer_client, contractor_client, contract_id = _draft_with_counterparty(
        "+79990860023", "+79990860024", "del-2"
    )
    resp = contractor_client.delete(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 204, resp.content


def test_delete_draft_by_stranger_is_403():
    customer_client, _contractor_client, contract_id = _draft_with_counterparty(
        "+79990860025", "+79990860026", "del-3"
    )
    stranger_client = APIClient()
    _login(stranger_client, "+79990860027")

    resp = stranger_client.delete(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 403, resp.content
    assert customer_client.get(f"/v1/contracts/{contract_id}").status_code == 200


def test_delete_sent_contract_is_409_draft_not_editable():
    customer_client, _contractor_client, contract_id = _draft_with_counterparty(
        "+79990860028", "+79990860029", "del-4"
    )
    send_resp = customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert send_resp.status_code == 200, send_resp.content

    resp = customer_client.delete(f"/v1/contracts/{contract_id}")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "draft_not_editable"
    assert Contract.objects.filter(id=contract_id).exists()


# --- ADR-151: порядок оплаты через API --------------------------------------


def _service_draft(customer_phone: str, contractor_phone: str, tag: str) -> tuple[APIClient, str]:
    customer_client = APIClient()
    _login(customer_client, customer_phone)
    contractor = User.objects.create(
        trust_id=f"trust-contracts-api-po-{tag}", phone=contractor_phone
    )
    contractor_profile = _person_profile(contractor)
    resp = customer_client.post(
        "/v1/contracts",
        {
            "client_option": "service",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["payment_order"] is None
    return customer_client, resp.data["id"]


def test_patch_draft_sets_payment_order():
    client, contract_id = _service_draft("+79990860060", "+79990860061", "1")
    resp = client.patch(
        f"/v1/contracts/{contract_id}", {"payment_order": "before_start"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["payment_order"] == "before_start"
    assert Contract.objects.get(id=contract_id).payment_order == "before_start"


def test_patch_draft_invalid_payment_order_is_400():
    client, contract_id = _service_draft("+79990860062", "+79990860063", "2")
    resp = client.patch(
        f"/v1/contracts/{contract_id}", {"payment_order": "prepayment"}, format="json"
    )
    assert resp.status_code == 400, resp.content
    assert Contract.objects.get(id=contract_id).payment_order is None


def test_send_without_payment_order_is_422():
    client, contract_id = _service_draft("+79990860064", "+79990860065", "3")
    resp = client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "payment_order_required"

    client.patch(
        f"/v1/contracts/{contract_id}", {"payment_order": "after_acceptance"}, format="json"
    )
    resp = client.post(f"/v1/contracts/{contract_id}/send", format="json")
    assert resp.status_code == 200, resp.content


def test_patch_loan_payment_order_is_400_not_applicable():
    customer_client, _contractor_client, contract_id = _draft_with_counterparty(
        "+79990860066", "+79990860067", "po-loan"
    )
    resp = customer_client.patch(
        f"/v1/contracts/{contract_id}", {"payment_order": "after_acceptance"}, format="json"
    )
    assert resp.status_code == 400, resp.content
    assert resp.data["code"] == "payment_order_not_applicable"
