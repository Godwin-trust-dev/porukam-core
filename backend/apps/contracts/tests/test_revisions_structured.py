"""ADR-157: структурные `item_ref` протокола разногласий — оплата
(`payment.method`/`payment.order`), этапы (`milestone.<uuid>.<поле>`) и
материалы (`material.<uuid>.<поле>`). Замечание владельца 03.09: «в
„Предложить правку“ нет ни типа оплаты и условий оплаты, надо чтобы были все
пункты» — раньше такие адреса принимались как свободный текст и при принятии
НЕ применялись (`applied: false`).

Каждый адрес и каждый запрет — отдельным тестом (CLAUDE.md).
"""

from __future__ import annotations

import itertools
import json
from decimal import Decimal
from pathlib import Path

import pytest
from django.conf import settings as django_settings
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.catalog.models import MaterialCatalogItem
from apps.contracts import services
from apps.contracts.models import Contract, ContractParty, RevisionProposal
from apps.l10n import services as l10n_services
from apps.milestones import services as milestones_services
from apps.milestones.models import ContractMaterial, Milestone
from apps.profiles.models import Profile
from common.fsm import InvalidTransitionError
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_STATUS = RevisionProposal.Status
_METHOD = Contract.PaymentMethod
_ORDER = Contract.PaymentOrder

_SERVICE_FORM = {
    "sphere_code": "renovation",
    "work_description": "Поклейка обоев в гостиной",
    "location_type": "remote",
    "term_type": "relative_to_gate",
    "duration_days": 14,
    "price_type": "fixed",
}


_seq = itertools.count(1)


def _api(user: User) -> APIClient:
    """Аутентифицированный клиент без прогона OTP — здесь проверяются коды
    ответов домена, а не вход (тот покрыт apps.accounts)."""
    api = APIClient()
    api.force_authenticate(user=user)
    return api


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-revstruct-{suffix}", phone=f"+7999089{suffix}")


def _profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=user, profile_visibility="link_and_deals"
    )


def _make_under_review(
    *, customer: User, contractor: User, contract_type_code: str | None = None
) -> Contract:
    """Договор на согласовании. Без `contract_type_code` — «Услуга» (тип
    выводится из статуса исполнителя); с ним — явный тип клиентского дерева
    (у займа `client_option` мало, нужен код: `_resolve_contract_type_code`)."""
    is_loan = contract_type_code is not None and contract_type_code.startswith("loan")
    draft = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option=None if contract_type_code else "service",
        contract_type_code=contract_type_code,
        counterparty_profile_id=_profile(contractor).id,
        payment_method=_METHOD.CASH,
        # ADR-151: у займа порядок оплаты неприменим.
        payment_order=None if is_loan else _ORDER.AFTER_ACCEPTANCE,
        title="Ремонт крана",
    )
    if contract_type_code is None:
        services.patch_draft(draft, user=customer, form_data=dict(_SERVICE_FORM))
    return services.send_for_review(draft, user=customer)


@pytest.fixture
def customer() -> User:
    return _user("0001")


@pytest.fixture
def contractor() -> User:
    return _user("0002")


@pytest.fixture
def contract(customer: User, contractor: User) -> Contract:
    return _make_under_review(customer=customer, contractor=contractor)


@pytest.fixture
def leaf(contract: Contract, customer: User) -> Milestone:
    return milestones_services.create_milestone(
        contract, user=customer, title="Работа", amount=Decimal("10000.00"), currency="RUB"
    )


@pytest.fixture
def catalog_code() -> str:
    return "other_renovation"


@pytest.fixture
def material(leaf: Milestone, customer: User, catalog_code: str) -> ContractMaterial:
    return milestones_services.create_material(
        leaf,
        user=customer,
        catalog_item_code=catalog_code,
        description="Плитка керамическая",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("500.00"),
        unit_price_currency="RUB",
        quantity=Decimal("10"),
        unit="м2",
        delivery_days=3,
    )


def _accept(proposal: RevisionProposal, *, user: User) -> RevisionProposal:
    """Правку принимает ДРУГАЯ сторона (`_responder_profile`)."""
    return services.accept_revision(proposal, user=user)


def _last_accept_payload(contract: Contract) -> dict:
    event = (
        OutboxEvent.objects.filter(
            topic="negotiation.revised", subject__id=str(contract.id), payload__action="accepted"
        )
        .order_by("-occurred_at", "-event_id")
        .first()
    )
    assert event is not None
    return dict(event.payload)


# --- Адресуемость (реестр) ---------------------------------------------------


@pytest.mark.parametrize(
    "item_ref",
    [
        "payment.method",
        "payment.order",
        "milestone.0195b1cf-0000-7000-8000-000000000001.title",
        "milestone.0195b1cf-0000-7000-8000-000000000001.amount",
        "milestone.0195b1cf-0000-7000-8000-000000000001.deadline",
        "milestone.0195b1cf-0000-7000-8000-000000000001.start_gate",
        "material.0195b1cf-0000-7000-8000-000000000001.type",
        "material.0195b1cf-0000-7000-8000-000000000001.quantity",
        "material.0195b1cf-0000-7000-8000-000000000001.delivery_days",
    ],
)
def test_structured_refs_are_addressable(item_ref: str):
    assert services.is_addressable_item_ref(item_ref)


@pytest.mark.parametrize(
    "item_ref",
    [
        "payment.schedule",  # нет такого поля оплаты
        "milestone.0195b1cf-0000-7000-8000-000000000001.color",  # нет такого поля этапа
        "milestone.not-a-uuid.amount",
        "material.0195b1cf-0000-7000-8000-000000000001.price",
        "milestones[2].amount",  # свободный адрес прежнего образца
        "Сроки по договору",
    ],
)
def test_unknown_refs_stay_free_form(item_ref: str):
    assert not services.is_addressable_item_ref(item_ref)


# --- payment.method ----------------------------------------------------------


def test_propose_payment_method_fills_old_value(contract: Contract, customer: User):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="payment.method", new_value=_METHOD.EXTERNAL
    )
    assert proposal.old_value == _METHOD.CASH


def test_accept_payment_method_applies_to_contract(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="payment.method", new_value=_METHOD.HOLD
    )
    _accept(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.payment_method == _METHOD.HOLD
    # `protected` — производная способа расчёта, обновляется вместе с ним.
    assert contract.protected is True
    payload = _last_accept_payload(contract)
    assert payload["applied"] is True
    assert payload["field"] == "payment.method"


def test_propose_abolished_prepayment_method_is_rejected(contract: Contract, customer: User):
    """ADR-155: способа `prepayment` больше нет — предоплата живёт в
    `payment_order=before_start`."""
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref="payment.method", new_value="prepayment"
        )
    assert excinfo.value.errors[0]["code"] == "invalid_choice"
    assert not contract.revision_proposals.exists()


def test_propose_non_string_payment_method_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionValueInvalidError):
        services.propose_revision(contract, user=customer, item_ref="payment.method", new_value=42)


# --- payment.order -----------------------------------------------------------


def test_accept_payment_order_applies_to_contract(
    contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref="payment.order", new_value=_ORDER.BEFORE_START
    )
    assert proposal.old_value == _ORDER.AFTER_ACCEPTANCE
    _accept(proposal, user=contractor)
    contract.refresh_from_db()
    assert contract.payment_order == _ORDER.BEFORE_START
    assert _last_accept_payload(contract)["applied"] is True


def test_propose_unknown_payment_order_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref="payment.order", new_value="postpayment"
        )
    assert excinfo.value.errors[0]["code"] == "invalid_choice"


def test_propose_payment_order_for_loan_is_rejected(customer: User, contractor: User):
    """ADR-151: у займа лист-этап — сам денежный транш, «оплата до/после
    исполнения этапа» смысла не имеет."""
    loan = _make_under_review(
        customer=customer, contractor=contractor, contract_type_code="loan_individuals"
    )
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            loan, user=customer, item_ref="payment.order", new_value=_ORDER.BEFORE_START
        )
    assert excinfo.value.errors[0]["code"] == "not_applicable"


# --- milestone.<uuid>.title --------------------------------------------------


def test_accept_milestone_title_applies(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.title", new_value="Демонтаж"
    )
    assert proposal.old_value == "Работа"
    _accept(proposal, user=contractor)
    leaf.refresh_from_db()
    assert leaf.title == "Демонтаж"
    assert _last_accept_payload(contract)["applied"] is True


def test_propose_empty_milestone_title_is_rejected(
    contract: Contract, leaf: Milestone, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"milestone.{leaf.id}.title", new_value="   "
        )
    assert excinfo.value.errors[0]["code"] == "required"


# --- milestone.<uuid>.amount -------------------------------------------------


def test_propose_milestone_amount_fills_money_pair_as_old_value(
    contract: Contract, leaf: Milestone, customer: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.amount", new_value="12000.00"
    )
    assert proposal.old_value == {"amount": "10000.00", "currency": "RUB"}


def test_accept_milestone_amount_applies_and_moves_contract_total(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    """Отдельного «объявленного итога» у договора нет: сумма ВЫЧИСЛЯЕТСЯ из
    листьев, поэтому правка суммы листа двигает сумму договора на ту же
    дельту, а инвариант «сумма листьев = сумма договора» держится сам."""
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.amount", new_value="12000.00"
    )
    _accept(proposal, user=contractor)
    leaf.refresh_from_db()
    assert leaf.amount == Decimal("12000.00")
    assert leaf.amount_currency == "RUB"
    total = milestones_services.total_leaf_amount(contract)
    assert total.amount == Decimal("12000.00")
    assert total.currency == "RUB"


def test_accept_milestone_amount_as_money_pair_applies(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract,
        user=customer,
        item_ref=f"milestone.{leaf.id}.amount",
        new_value={"amount": "9000.00", "currency": "RUB"},
    )
    _accept(proposal, user=contractor)
    leaf.refresh_from_db()
    assert leaf.amount == Decimal("9000.00")


def test_propose_milestone_amount_in_foreign_currency_is_rejected(
    contract: Contract, leaf: Milestone, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract,
            user=customer,
            item_ref=f"milestone.{leaf.id}.amount",
            new_value={"amount": "100.00", "currency": "USD"},
        )
    assert excinfo.value.errors[0]["code"] == "currency_mismatch"
    assert not contract.revision_proposals.exists()


def test_propose_negative_milestone_amount_is_rejected(
    contract: Contract, leaf: Milestone, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"milestone.{leaf.id}.amount", new_value="-1.00"
        )
    assert excinfo.value.errors[0]["code"] == "negative"


def test_propose_non_numeric_milestone_amount_is_rejected(
    contract: Contract, leaf: Milestone, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"milestone.{leaf.id}.amount", new_value="дорого"
        )
    assert excinfo.value.errors[0]["code"] == "invalid"


def test_propose_amount_on_branch_milestone_is_rejected(contract: Contract, customer: User):
    """Ветки только группируют — сумма задаётся на ЛИСТЬЯХ (tech-spec.md
    §6.1); тот же инвариант, что у БД-триггера `milestone_amount_guard`."""
    branch = milestones_services.create_milestone(contract, user=customer, title="Этап 1")
    milestones_services.create_milestone(
        contract,
        user=customer,
        title="Подэтап",
        parent=branch,
        amount=Decimal("500.00"),
        currency="RUB",
    )
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"milestone.{branch.id}.amount", new_value="700.00"
        )
    assert excinfo.value.errors[0]["code"] == "not_a_leaf"


# --- milestone.<uuid>.deadline -----------------------------------------------


def test_accept_milestone_deadline_applies_iso_date(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.deadline", new_value="2026-10-01"
    )
    assert proposal.old_value is None
    _accept(proposal, user=contractor)
    leaf.refresh_from_db()
    assert leaf.deadline is not None
    assert leaf.deadline.date().isoformat() == "2026-10-01"


def test_accept_milestone_deadline_applies_iso_datetime(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract,
        user=customer,
        item_ref=f"milestone.{leaf.id}.deadline",
        new_value="2026-10-01T15:30:00+03:00",
    )
    _accept(proposal, user=contractor)
    leaf.refresh_from_db()
    assert leaf.deadline is not None


def test_propose_broken_milestone_deadline_is_rejected(
    contract: Contract, leaf: Milestone, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"milestone.{leaf.id}.deadline", new_value="01.10.26"
        )
    assert excinfo.value.errors[0]["code"] == "invalid"


# --- milestone.<uuid>.start_gate ---------------------------------------------


def test_accept_start_gate_applies_dependency(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    """«Условие старта» карточки — предшественник этапа (`depends_on`):
    расчётные условия гейта ADR-155 сторонами не задаются."""
    second = milestones_services.create_milestone(
        contract, user=customer, title="Отделка", amount=Decimal("2000.00"), currency="RUB"
    )
    proposal = services.propose_revision(
        contract,
        user=customer,
        item_ref=f"milestone.{second.id}.start_gate",
        new_value=str(leaf.id),
    )
    assert proposal.old_value is None
    _accept(proposal, user=contractor)
    second.refresh_from_db()
    assert second.depends_on_id == leaf.id


def test_accept_empty_start_gate_clears_dependency(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    second = milestones_services.create_milestone(
        contract,
        user=customer,
        title="Отделка",
        amount=Decimal("2000.00"),
        currency="RUB",
        depends_on=leaf,
    )
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{second.id}.start_gate", new_value=""
    )
    assert proposal.old_value == str(leaf.id)
    _accept(proposal, user=contractor)
    second.refresh_from_db()
    assert second.depends_on_id is None


def test_propose_self_referencing_start_gate_is_rejected(
    contract: Contract, leaf: Milestone, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract,
            user=customer,
            item_ref=f"milestone.{leaf.id}.start_gate",
            new_value=str(leaf.id),
        )
    assert excinfo.value.errors[0]["code"] == "self_reference"


def test_propose_start_gate_on_foreign_milestone_is_rejected(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    other = _make_under_review(customer=_user("0011"), contractor=_user("0012"))
    foreign = milestones_services.create_milestone(
        other, user=other.created_by, title="Чужой", amount=Decimal("1.00"), currency="RUB"
    )
    with pytest.raises(services.RevisionItemUnknownError):
        services.propose_revision(
            contract,
            user=customer,
            item_ref=f"milestone.{leaf.id}.start_gate",
            new_value=str(foreign.id),
        )


# --- принадлежность цели договору --------------------------------------------


def test_propose_for_milestone_of_another_contract_is_rejected(contract: Contract, customer: User):
    other = _make_under_review(customer=_user("0021"), contractor=_user("0022"))
    foreign = milestones_services.create_milestone(
        other, user=other.created_by, title="Чужой", amount=Decimal("1.00"), currency="RUB"
    )
    with pytest.raises(services.RevisionItemUnknownError):
        services.propose_revision(
            contract, user=customer, item_ref=f"milestone.{foreign.id}.title", new_value="Мой"
        )
    assert not contract.revision_proposals.exists()


def test_propose_for_material_of_another_contract_is_rejected(
    contract: Contract, customer: User, catalog_code: str
):
    other = _make_under_review(customer=_user("0031"), contractor=_user("0032"))
    foreign_leaf = milestones_services.create_milestone(
        other, user=other.created_by, title="Чужой", amount=Decimal("1.00"), currency="RUB"
    )
    foreign_material = milestones_services.create_material(
        foreign_leaf,
        user=other.created_by,
        catalog_item_code=catalog_code,
        description="Чужая плитка",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("1.00"),
        unit_price_currency="RUB",
    )
    with pytest.raises(services.RevisionItemUnknownError):
        services.propose_revision(
            contract,
            user=customer,
            item_ref=f"material.{foreign_material.id}.quantity",
            new_value="2",
        )


def test_propose_for_missing_milestone_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionItemUnknownError):
        services.propose_revision(
            contract,
            user=customer,
            item_ref="milestone.0195b1cf-0000-7000-8000-0000000000ff.title",
            new_value="Нет такого",
        )


# --- material.<uuid>.* -------------------------------------------------------


def test_accept_material_type_applies_catalog_item(
    contract: Contract, material: ContractMaterial, customer: User, contractor: User
):
    other_code = (
        MaterialCatalogItem.objects.filter(is_active=True)
        .exclude(code=material.catalog_item.code)
        .values_list("code", flat=True)
        .first()
    )
    assert other_code, "в каталоге материалов должно быть больше одной активной позиции"
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"material.{material.id}.type", new_value=other_code
    )
    assert proposal.old_value == material.catalog_item.code
    _accept(proposal, user=contractor)
    material.refresh_from_db()
    assert material.catalog_item.code == other_code
    assert _last_accept_payload(contract)["applied"] is True


def test_propose_unknown_material_type_is_rejected(
    contract: Contract, material: ContractMaterial, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"material.{material.id}.type", new_value="плитка"
        )
    assert excinfo.value.errors[0]["code"] == "unknown_catalog_item"


def test_accept_material_quantity_applies(
    contract: Contract, material: ContractMaterial, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"material.{material.id}.quantity", new_value="12.5"
    )
    assert proposal.old_value == "10.000"
    _accept(proposal, user=contractor)
    material.refresh_from_db()
    assert material.quantity == Decimal("12.500")


def test_propose_zero_material_quantity_is_rejected(
    contract: Contract, material: ContractMaterial, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"material.{material.id}.quantity", new_value="0"
        )
    assert excinfo.value.errors[0]["code"] == "not_positive"


def test_propose_non_numeric_material_quantity_is_rejected(
    contract: Contract, material: ContractMaterial, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError):
        services.propose_revision(
            contract, user=customer, item_ref=f"material.{material.id}.quantity", new_value="много"
        )


def test_accept_material_delivery_days_applies(
    contract: Contract, material: ContractMaterial, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"material.{material.id}.delivery_days", new_value=7
    )
    assert proposal.old_value == 3
    _accept(proposal, user=contractor)
    material.refresh_from_db()
    assert material.delivery_days == 7


def test_propose_negative_material_delivery_days_is_rejected(
    contract: Contract, material: ContractMaterial, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError) as excinfo:
        services.propose_revision(
            contract, user=customer, item_ref=f"material.{material.id}.delivery_days", new_value=-1
        )
    assert excinfo.value.errors[0]["code"] == "negative"


def test_propose_fractional_material_delivery_days_is_rejected(
    contract: Contract, material: ContractMaterial, customer: User
):
    with pytest.raises(services.RevisionValueInvalidError):
        services.propose_revision(
            contract, user=customer, item_ref=f"material.{material.id}.delivery_days", new_value=1.5
        )


# --- обратная совместимость: неизвестный адрес -------------------------------


def test_unknown_ref_is_stored_and_not_applied(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    """Поведение как до ADR-157: свободный адрес фиксируется в протоколе,
    принимается, но к договору не применяется (`applied: false`)."""
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.color", new_value="синий"
    )
    assert proposal.old_value is None
    accepted = _accept(proposal, user=contractor)
    assert accepted.status == _STATUS.ACCEPTED
    payload = _last_accept_payload(contract)
    assert payload["applied"] is False
    assert payload["field"] is None


# --- прочие пути протокола ---------------------------------------------------


def test_accept_all_applies_structured_revisions(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    services.propose_revision(
        contract, user=customer, item_ref="payment.method", new_value=_METHOD.EXTERNAL
    )
    services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.title", new_value="Демонтаж"
    )
    services.accept_all_revisions(contract, user=contractor, confirm_summary=True)
    contract.refresh_from_db()
    leaf.refresh_from_db()
    assert contract.payment_method == _METHOD.EXTERNAL
    assert leaf.title == "Демонтаж"


def test_counter_revision_validates_structured_value(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    proposal = services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.amount", new_value="12000.00"
    )
    with pytest.raises(services.RevisionValueInvalidError):
        services.counter_revision(proposal, user=contractor, new_value="-5")


def test_preapproved_alternative_applies_structured_value(
    contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        contract, user=customer, item_ref="payment.method", payload={"method": _METHOD.EXTERNAL}
    )
    services.apply_preapproved_alternative(alternative, user=contractor)
    contract.refresh_from_db()
    assert contract.payment_method == _METHOD.EXTERNAL


def test_preapproved_alternative_without_value_is_rejected(contract: Contract, customer: User):
    with pytest.raises(services.RevisionValueInvalidError):
        services.create_preapproved_alternative(
            contract, user=customer, item_ref="payment.method", payload={"comment": "как-нибудь"}
        )


def test_amount_revision_is_financially_significant(
    contract: Contract, leaf: Milestone, customer: User, contractor: User
):
    """Правка суммы этапа требует `confirm_summary` в «принять все» — как и
    любой денежный адрес (`_is_financially_significant`)."""
    services.propose_revision(
        contract, user=customer, item_ref=f"milestone.{leaf.id}.amount", new_value="12000.00"
    )
    with pytest.raises(services.ConfirmSummaryRequiredError):
        services.accept_all_revisions(contract, user=contractor, confirm_summary=False)


# --- запреты по состоянию договора -------------------------------------------


def test_propose_structured_revision_after_signing_is_forbidden(customer: User, contractor: User):
    """Подписанный договор неизменяем — правки только до подписания
    (CLAUDE.md); FSM согласования отвечает 409."""
    from ._signing_helpers import make_signed_contract

    signed = make_signed_contract(customer=customer, contractor=contractor)
    milestone = signed.milestones.first()
    assert milestone is not None
    with pytest.raises(InvalidTransitionError):
        services.propose_revision(
            signed, user=customer, item_ref=f"milestone.{milestone.id}.title", new_value="Иначе"
        )


def test_propose_structured_revision_after_signing_returns_409(customer: User, contractor: User):
    from ._signing_helpers import make_signed_contract

    signed = make_signed_contract(customer=customer, contractor=contractor)
    milestone = signed.milestones.first()
    assert milestone is not None
    resp = _api(customer).post(
        f"/v1/contracts/{signed.id}/revisions",
        {"item_ref": f"milestone.{milestone.id}.title", "new_value": "Иначе"},
        format="json",
    )
    assert resp.status_code == 409, resp.content


def test_propose_foreign_milestone_returns_422(contract: Contract, customer: User):
    other = _make_under_review(customer=_user("0041"), contractor=_user("0042"))
    foreign = milestones_services.create_milestone(
        other, user=other.created_by, title="Чужой", amount=Decimal("1.00"), currency="RUB"
    )
    resp = _api(customer).post(
        f"/v1/contracts/{contract.id}/revisions",
        {"item_ref": f"milestone.{foreign.id}.title", "new_value": "Мой"},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.json()["code"] == "revision_item_unknown"


def test_propose_prepayment_method_returns_422(contract: Contract, customer: User):
    resp = _api(customer).post(
        f"/v1/contracts/{contract.id}/revisions",
        {"item_ref": "payment.method", "new_value": "prepayment"},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.json()["code"] == "revision_value_invalid"


# --- property-based: инвариант суммы листьев ---------------------------------


@given(
    amounts=st.lists(
        st.decimals(min_value=Decimal("0.01"), max_value=Decimal("9999.99"), places=2),
        min_size=2,
        max_size=4,
    ),
    new_amount=st.decimals(min_value=Decimal("0.00"), max_value=Decimal("9999.99"), places=2),
    index=st.integers(min_value=0, max_value=3),
)
@settings(
    max_examples=15,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
def test_leaf_sum_follows_accepted_amount_revision(amounts, new_amount, index):
    """Инвариант «сумма листьев = сумма договора» после правки суммы листа:
    отдельного объявленного итога нет, итог вычисляется из листьев, поэтому
    принятая правка двигает сумму договора ровно на свою дельту — при любом
    наборе сумм и любом выбранном листе."""
    # Свежая пара пользователей на КАЖДЫЙ пример Hypothesis (иначе они
    # копились бы между примерами одного прогона) — тот же приём, что
    # `_fresh_contract` в apps/milestones/tests/test_properties.py.
    n = next(_seq)
    buyer = User.objects.create(trust_id=f"trust-revprop-{n}c", phone=f"+7995{n:07d}")
    seller = User.objects.create(trust_id=f"trust-revprop-{n}p", phone=f"+7996{n:07d}")
    deal = _make_under_review(customer=buyer, contractor=seller)
    leaves = [
        milestones_services.create_milestone(
            deal, user=buyer, title=f"Этап {i}", amount=amount, currency="RUB"
        )
        for i, amount in enumerate(amounts)
    ]
    target = leaves[index % len(leaves)]
    before = milestones_services.total_leaf_amount(deal)

    proposal = services.propose_revision(
        deal, user=buyer, item_ref=f"milestone.{target.id}.amount", new_value=str(new_amount)
    )
    services.accept_revision(proposal, user=seller)

    after = milestones_services.total_leaf_amount(deal)
    assert after.currency == before.currency
    assert after.amount == before.amount - Decimal(target.amount) + Decimal(new_amount)


# --- хроника ДОГОВОРА: правки материалов (ADR-157 §5) ------------------------


@pytest.fixture
def _l10n_ru_pack():
    """Пакет ru в БД — подписи хроники отдаёт API из l10n-паков (ADR-134)."""
    packs_dir = Path(django_settings.BASE_DIR).parent / "l10n" / "packs"
    l10n_services.import_pack(json.loads((packs_dir / "ru.json").read_text(encoding="utf-8")))


@pytest.mark.usefixtures("_l10n_ru_pack")
def test_material_changes_are_shown_in_contract_timeline(
    contract: Contract, material: ContractMaterial, customer: User
):
    """Замечание владельца 03.09: правки материалов в согласовании проходят
    без раунда — вторая сторона должна видеть их в ленте самого ДОГОВОРА, а
    не только открыв этап. Подписи — те же ключи, что у хроники этапа
    (ADR-156)."""
    milestones_services.patch_material(material, user=customer, quantity=Decimal("12"))
    milestones_services.delete_material(material, user=customer)

    resp = _api(customer).get(f"/v1/contracts/{contract.id}/timeline", HTTP_ACCEPT_LANGUAGE="ru")
    assert resp.status_code == 200, resp.content
    entries = [e for e in resp.data if e["kind"].startswith("milestone.material_")]
    assert [e["kind"] for e in entries] == [
        "milestone.material_added",
        "milestone.material_updated",
        "milestone.material_removed",
    ]
    assert all(e["nested"] is True for e in entries)
    for entry in entries:
        assert entry["payload"]["milestone_title"] == "Работа"
        assert entry["title"], entry["kind"]
        assert entry["detail"] == "«Работа»"
