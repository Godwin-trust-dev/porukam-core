"""ADR-155: гейт старта листа — предоплата как условие старта
(`Contract.payment_order=before_start`), тройное состояние условий
(`gate_status()["conditions"]`) и двустороннее подтверждение материалов.

Каждый переход и каждый запрет — отдельным тестом (CLAUDE.md).

Зеркало `paid_confirmed_*` здесь ставится прямым вызовом
`services.confirm_payment` — apps.milestones НЕ ИМЕЕТ ПРАВА импортировать
apps.payments (import-linter, ADR-130), и эти тесты проверяют именно гейт,
а не платёжный контур. Сквозной путь «настоящий Payment -> зеркало -> гейт
-> приёмка» живёт там, где ему место, — в `apps/payments/tests/
test_services.py` (раздел ADR-155).
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.utils import timezone

from apps.catalog.models import MaterialCatalogItem
from apps.contracts.models import Contract, ContractParty
from apps.evidence import services as evidence_services
from apps.milestones import services
from apps.milestones.models import ContractMaterial, Milestone

from ._execution_helpers import (
    add_checklist_item_with_evidence,
    add_customer_material,
    make_signed_contract_with_leaf,
    make_user,
)

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role
_STATUS = Milestone.Status
_METHOD = Contract.PaymentMethod
_ORDER = Contract.PaymentOrder


@pytest.fixture
def customer():
    return make_user("g001")


@pytest.fixture
def contractor():
    return make_user("g002")


@pytest.fixture
def before_start(customer, contractor):
    """Подписанный договор с одним денежным листом и предоплатой."""
    return make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.BEFORE_START,
    )


def _catalog_item_code() -> str:
    item = MaterialCatalogItem.objects.filter(is_active=True).first()
    assert item is not None, "фикстуры каталога материалов должны быть засеяны"
    return str(item.code)


def _pay_leaf(contract: Contract, milestone: Milestone, *, customer, contractor) -> Milestone:
    """Оплата листа обеими сторонами (зеркало, которое в проде пишет
    apps.payments — см. докстринг модуля)."""
    services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    milestone.refresh_from_db()
    return milestone


def _accept_leaf(contract: Contract, milestone: Milestone, *, customer, contractor) -> Milestone:
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )
    services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    services.accept_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    return milestone


# --- Гейт старта при before_start ------------------------------------------


def test_start_before_start_without_payment_is_refused(before_start, customer):
    contract, milestone = before_start
    with pytest.raises(services.GateFinancialConditionNotMetError) as excinfo:
        services.start_milestone(milestone, user=customer)
    assert excinfo.value.reason == "payment_not_confirmed"


def test_start_before_start_with_one_side_confirmed_is_refused(before_start, customer, contractor):
    """Односторонняя отметка — не оплата (ровно как у аванса §6.3)."""
    contract, milestone = before_start
    services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestone.refresh_from_db()
    with pytest.raises(services.GateFinancialConditionNotMetError) as excinfo:
        services.start_milestone(milestone, user=customer)
    assert excinfo.value.reason == "payment_not_confirmed"


def test_start_before_start_after_payment_confirmed(before_start, customer, contractor):
    contract, milestone = before_start
    _pay_leaf(contract, milestone, customer=customer, contractor=contractor)
    result = services.start_milestone(milestone, user=customer)
    assert result.status == _STATUS.IN_PROGRESS
    # Оплата ДО старта не делает лист «оплаченным» — работа ещё не сдана.
    assert result.status != _STATUS.PAID


def test_start_after_acceptance_cash_needs_no_payment(customer, contractor):
    """Постоплата: гейт денег не спрашивает — в этом вся разница осей."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.AFTER_ACCEPTANCE,
    )
    result = services.start_milestone(milestone, user=customer)
    assert result.status == _STATUS.IN_PROGRESS


def test_start_before_start_direct_platform_is_awaiting_payment(customer, contractor):
    """Партнёра нет — наблюдать оплату нечем; честная заглушка сохраняется
    и при предоплате (ADR-130), новой причиной её не подменяем."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.DIRECT_PLATFORM,
        payment_order=_ORDER.BEFORE_START,
    )
    with pytest.raises(services.GateFinancialConditionNotMetError) as excinfo:
        services.start_milestone(milestone, user=customer)
    assert excinfo.value.reason == "awaiting_payment"


def test_payment_order_null_keeps_method_gate(customer, contractor):
    """Займ / договоры, замороженные до ADR-151: `payment_order=None` —
    платить ДО старта не надо, условие считается по способу расчёта."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.CASH
    )
    contract.payment_order = None
    contract.save(update_fields=["payment_order"])
    milestone.refresh_from_db()
    status_report = services.gate_status(milestone)
    assert status_report["conditions"]["financial"] == services.CONDITION_NOT_REQUIRED
    assert services.start_milestone(milestone, user=customer).status == _STATUS.IN_PROGRESS


def test_payment_order_null_direct_platform_still_awaits_payment(customer, contractor):
    """Партнёра нет — наблюдать платёж нечем; честная заглушка (ADR-130)
    переживает упразднение способа `prepayment`."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.DIRECT_PLATFORM
    )
    contract.payment_order = None
    contract.save(update_fields=["payment_order"])
    milestone.refresh_from_db()
    with pytest.raises(services.GateFinancialConditionNotMetError) as excinfo:
        services.start_milestone(milestone, user=customer)
    assert excinfo.value.reason == "awaiting_payment"


def test_prepayment_payment_method_no_longer_exists():
    """ADR-155 (владелец 03.09: «предоплата с двусторонним подтверждением —
    там быть не должно. Можешь смело удалять»): предоплата живёт ровно в
    одном месте — `payment_order`, а не вторым именем в способе расчёта."""
    assert not hasattr(Contract.PaymentMethod, "PREPAYMENT")
    assert "prepayment" not in dict(Contract.PaymentMethod.choices)


# --- Закрытие листа при before_start ---------------------------------------


def test_acceptance_closes_prepaid_leaf_as_paid(before_start, customer, contractor):
    contract, milestone = before_start
    _pay_leaf(contract, milestone, customer=customer, contractor=contractor)
    services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    _accept_leaf(contract, milestone, customer=customer, contractor=contractor)
    assert milestone.status == _STATUS.PAID
    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.WARRANTY


def test_acceptance_does_not_pay_unpaid_leaf_at_after_acceptance(customer, contractor):
    """Контроль: при постоплате приёмка листа деньгами его не закрывает."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.AFTER_ACCEPTANCE,
    )
    services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    _accept_leaf(contract, milestone, customer=customer, contractor=contractor)
    assert milestone.status == _STATUS.ACCEPTED


def test_prepaid_leaf_rejected_then_accepted_is_paid(before_start, customer, contractor):
    """Спор по предоплаченному этапу (ADR-155 §5): деньги платформа не
    держит и не отзывает — исход «принято» закрывает лист оплаченным."""
    contract, milestone = before_start
    _pay_leaf(contract, milestone, customer=customer, contractor=contractor)
    services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )
    services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    services.reject_milestone(
        milestone, user=customer, checklist_item_id=item.id, evidence=["нет фото"]
    )
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.DISPUTED
    # Зеркала оплаты спор не трогает — деньги уже у исполнителя.
    assert milestone.paid_confirmed_by_customer_at is not None

    services.finalize_acceptance(milestone, actor_user=customer, auto=False)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.PAID


# --- conditions: тройное состояние условий гейта ---------------------------


def test_conditions_all_waiting_until_signed(customer, contractor):
    """Замечание владельца 03.09: пока договор не подписан, «Готово» не
    показываем ни по одному условию — все три «Ждём»."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.CASH
    )
    contract.negotiation_status = Contract.NegotiationStatus.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    milestone.refresh_from_db()
    conditions = services.gate_status(milestone)["conditions"]
    assert conditions == {
        "signed": services.CONDITION_WAITING,
        "materials": services.CONDITION_WAITING,
        "financial": services.CONDITION_WAITING,
    }


def test_conditions_not_required_for_absent_materials_and_postpaid_cash(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.AFTER_ACCEPTANCE,
    )
    status_report = services.gate_status(milestone)
    assert status_report["conditions"] == {
        "signed": services.CONDITION_MET,
        "materials": services.CONDITION_NOT_REQUIRED,
        "financial": services.CONDITION_NOT_REQUIRED,
    }
    assert status_report["can_start"] is True


def test_conditions_financial_waiting_then_met_at_before_start(before_start, customer, contractor):
    contract, milestone = before_start
    assert services.gate_status(milestone)["conditions"]["financial"] == services.CONDITION_WAITING
    _pay_leaf(contract, milestone, customer=customer, contractor=contractor)
    assert services.gate_status(milestone)["conditions"]["financial"] == services.CONDITION_MET


def test_conditions_materials_waiting_then_met(before_start, customer, contractor):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    assert services.gate_status(milestone)["conditions"]["materials"] == services.CONDITION_WAITING
    services.confirm_material_handed_over(material, user=customer)
    assert services.gate_status(milestone)["conditions"]["materials"] == services.CONDITION_WAITING
    services.confirm_material_received(material, user=contractor)
    assert services.gate_status(milestone)["conditions"]["materials"] == services.CONDITION_MET


# --- Материалы: двустороннее подтверждение ---------------------------------


def test_material_handed_over_only_by_source_side(before_start, customer, contractor):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    with pytest.raises(services.MaterialHandoverWrongSideError):
        services.confirm_material_handed_over(material, user=contractor)


def test_material_received_only_by_other_side(before_start, customer, contractor):
    """Односторонность получения не значит «кто угодно»: сторона-источник
    подтвердить получение ЗА СЕБЯ по-прежнему не может — иначе поставщик
    материалов открывал бы гейт этапа сам себе."""
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    services.confirm_material_handed_over(material, user=customer)
    with pytest.raises(services.MaterialHandoverWrongSideError):
        services.confirm_material_received(material, user=customer)


def test_material_received_without_handover_is_allowed(before_start, customer, contractor):
    """Владелец 03.09: «Исполнитель может в одностороннем порядке поставить
    "получены". Сделаем жизнь людям чуть легче» — ждать кнопки заказчика
    принимающая сторона не обязана."""
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    result = services.confirm_material_received(material, user=contractor)
    assert result.received is True
    assert result.handed_over_at is None
    assert services.gate_status(milestone)["materials_ready"] is True


def test_material_handed_over_is_idempotent(before_start, customer):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    first = services.confirm_material_handed_over(material, user=customer)
    stamp = first.handed_over_at
    again = services.confirm_material_handed_over(material, user=customer)
    assert again.handed_over_at == stamp


def test_contractor_material_handover_sides_are_mirrored(before_start, customer, contractor):
    """`source=contractor`: передаёт исполнитель, принимает заказчик. Гейт
    такие материалы не блокирует (domain-model.md §7.3) — проверяются
    только стороны."""
    contract, milestone = before_start
    material = ContractMaterial.objects.create(
        milestone=milestone,
        catalog_item=MaterialCatalogItem.objects.filter(is_active=True).first(),
        description="Свой инструмент",
        unit_price=Decimal("100.00"),
        unit_price_currency="RUB",
        source=ContractMaterial.Source.CONTRACTOR,
    )
    with pytest.raises(services.MaterialHandoverWrongSideError):
        services.confirm_material_handed_over(material, user=customer)
    services.confirm_material_handed_over(material, user=contractor)
    services.confirm_material_received(material, user=customer)
    material.refresh_from_db()
    assert material.received is True


def test_gate_opens_on_receipt_not_on_handover(before_start, customer, contractor):
    """Гейт двигает ТОЛЬКО «получено» (`_materials_ready` не менялся):
    «передано» — сигнал источника, а не факт получения."""
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    _pay_leaf(contract, milestone, customer=customer, contractor=contractor)

    with pytest.raises(services.GateMaterialsNotReadyError):
        services.start_milestone(milestone, user=customer)
    services.confirm_material_handed_over(material, user=customer)
    with pytest.raises(services.GateMaterialsNotReadyError):
        services.start_milestone(milestone, user=customer)
    services.confirm_material_received(material, user=contractor)
    assert services.start_milestone(milestone, user=customer).status == _STATUS.IN_PROGRESS


# --- Редактирование материалов до подписания -------------------------------


def test_patch_and_delete_material_while_draft(customer, contractor):
    from ._helpers import make_contract

    contract = make_contract(customer=customer, contractor=contractor)
    milestone = services.create_milestone(
        contract,
        user=customer,
        title="Этап",
        amount=Decimal("1000.00"),
        currency="RUB",
    )
    material = services.create_material(
        milestone,
        user=customer,
        catalog_item_code=_catalog_item_code(),
        description="Плитка",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("0"),
        unit_price_currency="RUB",
    )
    patched = services.patch_material(
        material, user=customer, description="Плитка 60x60", unit="м2"
    )
    assert patched.description == "Плитка 60x60"
    assert patched.unit == "м2"

    services.delete_material(material, user=customer)
    assert not ContractMaterial.objects.filter(id=material.id).exists()


def test_patch_material_after_signing_is_refused(before_start, customer):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    with pytest.raises(services.StructureNotEditableError):
        services.patch_material(material, user=customer, description="другое")


def test_delete_material_after_signing_is_refused(before_start, customer):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    with pytest.raises(services.StructureNotEditableError):
        services.delete_material(material, user=customer)


def test_patch_material_keeps_price_rule(customer, contractor):
    """Правило ADR-047 действует и на правке: исполнитель не поставляет
    материал по нулевой цене."""
    from ._helpers import make_contract

    contract = make_contract(customer=customer, contractor=contractor)
    milestone = services.create_milestone(
        contract, user=customer, title="Этап", amount=Decimal("1000.00"), currency="RUB"
    )
    material = services.create_material(
        milestone,
        user=customer,
        catalog_item_code=_catalog_item_code(),
        description="Плитка",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("0"),
        unit_price_currency="RUB",
    )
    with pytest.raises(services.MaterialPriceRequiredError):
        services.patch_material(material, user=customer, source=ContractMaterial.Source.CONTRACTOR)


def test_material_receipt_stamps_who(before_start, customer, contractor):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    services.confirm_material_handed_over(material, user=customer)
    services.confirm_material_received(material, user=contractor)
    material.refresh_from_db()
    assert material.handed_over_by_id == customer.id
    assert material.received_by_id == contractor.id
    assert material.handed_over_at is not None
    assert material.received_at is not None
    assert material.handed_over_at <= timezone.now()


# --- HTTP-контракт (то, что увидит фронт) ----------------------------------


def _client(user):
    from rest_framework.test import APIClient

    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_gate_endpoint_returns_conditions(before_start, customer):
    contract, milestone = before_start
    resp = _client(customer).get(f"/v1/milestones/{milestone.id}/gate")
    assert resp.status_code == 200, resp.content
    assert resp.data["conditions"] == {
        "signed": "met",
        "materials": "not_required",
        "financial": "waiting",
    }
    # Старые булевы ключи остались — фронт мигрирует без слома.
    assert resp.data["signed"] is True
    assert resp.data["financial_condition_met"] is False
    assert resp.data["financial_condition_reason"] == "payment_not_confirmed"


def test_start_endpoint_reports_reason_in_problem_context(before_start, customer):
    contract, milestone = before_start
    resp = _client(customer).post(f"/v1/milestones/{milestone.id}/start")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "gate_financial_condition_not_met"
    assert resp.data["context"] == {"reason": "payment_not_confirmed"}


def test_material_handed_over_then_received_via_api(before_start, customer, contractor):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)

    # «Передал» может только сторона-источник (здесь — заказчик).
    resp = _client(contractor).post(f"/v1/materials/{material.id}/handed-over")
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "material_handover_wrong_side"

    resp = _client(customer).post(f"/v1/materials/{material.id}/handed-over")
    assert resp.status_code == 200, resp.content
    assert resp.data["handed_over_at"] is not None
    assert resp.data["received"] is False

    # «Получил» — только другая сторона.
    resp = _client(customer).post(f"/v1/materials/{material.id}/received")
    assert resp.status_code == 403, resp.content

    resp = _client(contractor).post(f"/v1/materials/{material.id}/received")
    assert resp.status_code == 200, resp.content
    assert resp.data["received"] is True


def test_patch_material_changes_catalog_item(customer, contractor):
    """Фронт (`feat/web-wizard-materials`) в режиме правки позволяет сменить
    наименование из каталога и шлёт diff всех полей — `catalog_item_code`
    принимается тем же резолвом, что при создании."""
    from apps.catalog.models import MaterialCatalogItem

    from ._helpers import make_contract

    contract = make_contract(customer=customer, contractor=contractor)
    milestone = services.create_milestone(
        contract, user=customer, title="Этап", amount=Decimal("1000.00"), currency="RUB"
    )
    first, second = list(MaterialCatalogItem.objects.filter(is_active=True)[:2])
    material = services.create_material(
        milestone,
        user=customer,
        catalog_item_code=first.code,
        description="Плитка",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("0"),
        unit_price_currency="RUB",
    )

    patched = services.patch_material(
        material, user=customer, catalog_item_code=second.code, description="Другая позиция"
    )
    assert patched.catalog_item_id == second.id
    assert patched.description == "Другая позиция"


def test_patch_material_unknown_catalog_item_is_404(customer, contractor):
    from ._helpers import make_contract

    contract = make_contract(customer=customer, contractor=contractor)
    milestone = services.create_milestone(
        contract, user=customer, title="Этап", amount=Decimal("1000.00"), currency="RUB"
    )
    material = services.create_material(
        milestone,
        user=customer,
        catalog_item_code=_catalog_item_code(),
        description="Плитка",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("0"),
        unit_price_currency="RUB",
    )
    with pytest.raises(services.MaterialCatalogItemNotFoundError):
        services.patch_material(material, user=customer, catalog_item_code="нет-такой-позиции")
