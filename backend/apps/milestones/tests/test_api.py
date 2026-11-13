"""apps.milestones.api — Э4.3 приёмка (docs/tasks/etap-4.md): собрать
дерево «этаж → комната → работы» в черновике через Swagger-эквивалентный
API-флоу; сумма ветки вычисляется; amount у ветки → 422; для «Займа»
график возврата создаётся как этапы-листья."""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty

from ._helpers import make_person_profile

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


def _make_service_contract(customer: User, contractor: User) -> Contract:
    contractor_profile = make_person_profile(contractor)
    return contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        contract_type_code="services_individual",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
    )


def test_build_floor_room_works_tree_via_api():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870001")
    contractor = User.objects.create(trust_id="trust-milestones-api-1", phone="+79990870002")
    contract = _make_service_contract(customer, contractor)

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones", {"title": "Этаж 1"}, format="json"
    )
    assert resp.status_code == 201, resp.content
    floor_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Комната 101", "parent_id": floor_id},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    room_id = resp.data["id"]

    for title, amount in (("Обои", "15000.00"), ("Плитка", "25000.00")):
        resp = customer_client.post(
            f"/v1/contracts/{contract.id}/milestones",
            {"title": title, "parent_id": room_id, "amount": amount, "currency": "RUB"},
            format="json",
        )
        assert resp.status_code == 201, resp.content

    resp = customer_client.get(f"/v1/contracts/{contract.id}/milestones?view=tree")
    assert resp.status_code == 200, resp.content
    tree = resp.data
    assert len(tree) == 1
    floor_node = tree[0]
    assert floor_node["id"] == floor_id
    assert floor_node["amount"] == "40000.00"
    assert floor_node["currency"] == "RUB"
    room_node = floor_node["children"][0]
    assert room_node["id"] == room_id
    assert room_node["amount"] == "40000.00"
    assert {c["amount"] for c in room_node["children"]} == {"15000.00", "25000.00"}


def test_amount_on_branch_returns_422():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870003")
    contractor = User.objects.create(trust_id="trust-milestones-api-2", phone="+79990870004")
    contract = _make_service_contract(customer, contractor)

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones", {"title": "Ветка"}, format="json"
    )
    branch_id = resp.data["id"]
    customer_client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Лист", "parent_id": branch_id},
        format="json",
    )

    resp = customer_client.patch(
        f"/v1/milestones/{branch_id}", {"amount": "1.00", "currency": "RUB"}, format="json"
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "milestone_amount_guard"


def test_checklist_recommendations_and_creation_via_api():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870005")
    contractor = User.objects.create(trust_id="trust-milestones-api-3", phone="+79990870006")
    contract = _make_service_contract(customer, contractor)

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Плитка", "amount": "1.00", "currency": "RUB"},
        format="json",
    )
    leaf_id = resp.data["id"]

    resp = customer_client.post(
        f"/v1/milestones/{leaf_id}/materials",
        {
            "catalog_item_code": "renovation_tile",
            "description": "Кафель 30х30",
            "source": "customer",
            "unit_price": "0",
            "unit_price_currency": "RUB",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content

    resp = customer_client.get(f"/v1/milestones/{leaf_id}/checklist-recommendations")
    assert resp.status_code == 200, resp.content
    descriptions = {r["description"] for r in resp.data}
    assert "Плитка уложена без перепадов по высоте" in descriptions

    recommendation = next(r for r in resp.data if "перепадов" in r["description"])
    resp = customer_client.post(
        f"/v1/milestones/{leaf_id}/checklist-items",
        {
            "description": recommendation["description"],
            "measurable_criterion": recommendation["measurable_criterion"],
            "required_evidence": recommendation["required_evidence"],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["required_evidence"] == recommendation["required_evidence"]


def test_loan_schedule_materialized_as_leaf_milestones_via_api():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870007")
    contractor = User.objects.create(trust_id="trust-milestones-api-4", phone="+79990870008")
    contractor_profile = make_person_profile(contractor)
    contract = contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        form_data={
            "amount": "100000",
            "interest_type": "interest_free",
            "repayment_type": "schedule",
            "schedule": [
                {"due_date": "2026-09-01", "amount": "50000"},
                {"due_date": "2026-10-01", "amount": "50000"},
            ],
            "transfer_method": "platform",
        },
    )

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones/loan-schedule", {"currency": "RUB"}, format="json"
    )
    assert resp.status_code == 201, resp.content
    assert len(resp.data) == 2
    assert {m["amount"] for m in resp.data} == {"50000.00"}
    assert all(m["parent_id"] is None for m in resp.data)


def test_delete_milestone_via_api_then_409_after_signing():
    """ADR-101: DELETE /milestones/{id} — 204 в черновике, поддерево уходит из
    дерева; после подписания — 409 contract_immutable (как у PATCH)."""
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870011")
    contractor = User.objects.create(trust_id="trust-milestones-api-del", phone="+79990870012")
    contract = _make_service_contract(customer, contractor)

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Этап 1", "amount": "100.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    first_id = resp.data["id"]
    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Этап 2", "amount": "200.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    second_id = resp.data["id"]

    resp = customer_client.delete(f"/v1/milestones/{first_id}")
    assert resp.status_code == 204, resp.content
    resp = customer_client.get(f"/v1/contracts/{contract.id}/milestones")
    assert [n["id"] for n in resp.data] == [second_id]

    contract.negotiation_status = Contract.NegotiationStatus.SIGNED
    contract.save(update_fields=["negotiation_status"])
    resp = customer_client.delete(f"/v1/milestones/{second_id}")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "contract_immutable"


def test_delete_milestone_stranger_403():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870013")
    contractor = User.objects.create(trust_id="trust-milestones-api-del2", phone="+79990870014")
    contract = _make_service_contract(customer, contractor)
    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones", {"title": "Этап"}, format="json"
    )
    milestone_id = resp.data["id"]

    stranger_client = APIClient()
    _login(stranger_client, "+79990870015")
    resp = stranger_client.delete(f"/v1/milestones/{milestone_id}")
    assert resp.status_code == 403, resp.content


# --- пункт чек-листа: PATCH/DELETE до подписания (мастер, 2026-08-25) --------


def _create_leaf_with_items(client: APIClient, contract: Contract, n: int) -> tuple[str, list[str]]:
    resp = client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Этап", "amount": "100.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    leaf_id = resp.data["id"]
    item_ids: list[str] = []
    for i in range(n):
        resp = client.post(
            f"/v1/milestones/{leaf_id}/checklist-items",
            {"description": f"критерий {i}", "measurable_criterion": f"мера {i}", "order": i},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        item_ids.append(resp.data["id"])
    return leaf_id, item_ids


def test_checklist_items_unlimited_then_delete_and_patch_via_api():
    """Отсмотр 2026-08-25: число критериев не ограничено; пункт удаляется
    (204, уходит из GET-списка) и правится (200) до подписания."""
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870016")
    contractor = User.objects.create(trust_id="trust-milestones-api-ci1", phone="+79990870017")
    contract = _make_service_contract(customer, contractor)
    leaf_id, item_ids = _create_leaf_with_items(customer_client, contract, 5)

    resp = customer_client.get(f"/v1/milestones/{leaf_id}/checklist-items")
    assert resp.status_code == 200, resp.content
    assert [c["id"] for c in resp.data] == item_ids

    resp = customer_client.delete(f"/v1/checklist-items/{item_ids[1]}")
    assert resp.status_code == 204, resp.content
    resp = customer_client.get(f"/v1/milestones/{leaf_id}/checklist-items")
    assert [c["id"] for c in resp.data] == [item_ids[0], *item_ids[2:]]

    resp = customer_client.patch(
        f"/v1/checklist-items/{item_ids[0]}",
        {"description": "новый текст", "required_evidence": ["photo"], "order": 7},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["id"] == item_ids[0]
    assert resp.data["description"] == "новый текст"
    assert resp.data["measurable_criterion"] == "мера 0"
    assert resp.data["required_evidence"] == ["photo"]
    assert resp.data["order"] == 7


def test_checklist_item_patch_delete_409_after_signing():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870018")
    contractor = User.objects.create(trust_id="trust-milestones-api-ci2", phone="+79990870019")
    contract = _make_service_contract(customer, contractor)
    leaf_id, (item_id,) = _create_leaf_with_items(customer_client, contract, 1)

    contract.negotiation_status = Contract.NegotiationStatus.SIGNED
    contract.save(update_fields=["negotiation_status"])
    resp = customer_client.patch(
        f"/v1/checklist-items/{item_id}", {"description": "x"}, format="json"
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "contract_immutable"
    resp = customer_client.delete(f"/v1/checklist-items/{item_id}")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "contract_immutable"
    resp = customer_client.get(f"/v1/milestones/{leaf_id}/checklist-items")
    assert [c["id"] for c in resp.data] == [item_id]
    assert resp.data[0]["description"] == "критерий 0"


def test_checklist_item_patch_delete_stranger_403_and_unknown_404():
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870020")
    contractor = User.objects.create(trust_id="trust-milestones-api-ci3", phone="+79990870021")
    contract = _make_service_contract(customer, contractor)
    _, (item_id,) = _create_leaf_with_items(customer_client, contract, 1)

    stranger_client = APIClient()
    _login(stranger_client, "+79990870022")
    resp = stranger_client.patch(f"/v1/checklist-items/{item_id}", {"order": 1}, format="json")
    assert resp.status_code == 403, resp.content
    resp = stranger_client.delete(f"/v1/checklist-items/{item_id}")
    assert resp.status_code == 403, resp.content

    resp = customer_client.delete("/v1/checklist-items/00000000-0000-0000-0000-000000000001")
    assert resp.status_code == 404, resp.content


# --- репродукция отсмотра 2026-08-25: «после одного критерия другие не сохраняются» ---


def _make_contract_of_type(customer: User, contractor: User, code: str) -> Contract:
    contractor_profile = make_person_profile(contractor)
    return contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        contract_type_code=code,
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
    )


def test_rent_contract_second_and_third_checklist_items_are_saved():
    """Договор аренды, критерии добавляются подряд БЕЗ явного `order`
    (мастер шлёт default=0) — ограничения на количество и уникальности
    (milestone, order)/(milestone, description) на бэке НЕТ, сохраняются все.
    Причина жалобы «второй критерий не сохраняется» — на фронте
    (StagesStepPage: `isStageChecklistEditable` + `next()` не досылает пункты
    уже созданному этапу), бэк принимает любое количество."""
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870023")
    contractor = User.objects.create(trust_id="trust-milestones-api-ci4", phone="+79990870024")
    contract = _make_contract_of_type(customer, contractor, "rent_home")

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Месяц 1", "amount": "30000.00", "currency": "RUB"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    leaf_id = resp.data["id"]

    created: list[str] = []
    for text in ("показания счётчиков", "показания счётчиков", "ключи возвращены"):
        resp = customer_client.post(
            f"/v1/milestones/{leaf_id}/checklist-items",
            {"description": text, "measurable_criterion": text},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        assert resp.data["order"] == 0  # default — одинаковый у всех, это не мешает
        created.append(resp.data["id"])

    resp = customer_client.get(f"/v1/milestones/{leaf_id}/checklist-items")
    assert resp.status_code == 200, resp.content
    # при равном order порядок стабилен по created_at (selectors.list_checklist_items)
    assert [c["id"] for c in resp.data] == created


def test_delete_checklist_item_then_renumber_rest():
    """Удаление пункта не ломает нумерацию: остальные перенумеровываются
    через PATCH `order` (то, чего фронту не хватало)."""
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870025")
    contractor = User.objects.create(trust_id="trust-milestones-api-ci5", phone="+79990870026")
    contract = _make_contract_of_type(customer, contractor, "rent_items")
    leaf_id, item_ids = _create_leaf_with_items(customer_client, contract, 3)

    resp = customer_client.delete(f"/v1/checklist-items/{item_ids[0]}")
    assert resp.status_code == 204, resp.content

    rest = item_ids[1:]
    for new_order, item_id in enumerate(rest):
        resp = customer_client.patch(
            f"/v1/checklist-items/{item_id}", {"order": new_order}, format="json"
        )
        assert resp.status_code == 200, resp.content

    resp = customer_client.get(f"/v1/milestones/{leaf_id}/checklist-items")
    assert [(c["id"], c["order"]) for c in resp.data] == [(rest[0], 0), (rest[1], 1)]


def test_material_patch_and_delete_via_api_while_draft():
    """ADR-155 (владелец 03.09): «если договор редактируется, должна быть
    возможность редактировать и материалы»."""
    customer_client = APIClient()
    customer = _login(customer_client, "+79990870011")
    contractor = User.objects.create(trust_id="trust-milestones-api-6", phone="+79990870012")
    contract = _make_service_contract(customer, contractor)

    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/milestones",
        {"title": "Плитка", "amount": "1.00", "currency": "RUB"},
        format="json",
    )
    leaf_id = resp.data["id"]
    resp = customer_client.post(
        f"/v1/milestones/{leaf_id}/materials",
        {
            "catalog_item_code": "renovation_tile",
            "description": "Кафель 30х30",
            "source": "customer",
            "unit_price": "0",
            "unit_price_currency": "RUB",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    material_id = resp.data["id"]
    assert resp.data["handed_over_at"] is None
    assert resp.data["received"] is False

    resp = customer_client.patch(
        f"/v1/materials/{material_id}",
        {"description": "Кафель 60х60", "unit": "м2"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["description"] == "Кафель 60х60"
    assert resp.data["unit"] == "м2"

    resp = customer_client.delete(f"/v1/materials/{material_id}")
    assert resp.status_code == 204, resp.content
    resp = customer_client.get(f"/v1/milestones/{leaf_id}/materials")
    assert resp.data == []
