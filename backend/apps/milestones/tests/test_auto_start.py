"""ADR-162 (решение владельца 05.09: «Как только выполнены все условия —
автоматическое начало этапа. сейчас ждёт ручного подтверждения. лишняя
активность»): лист входит в работу САМ в момент закрытия последнего условия
гейта §6.3.

Каждый путь закрытия — отдельным тестом, каждый запрет — тоже (CLAUDE.md).
Зеркало `paid_confirmed_*` ставится прямым вызовом `services.confirm_payment`
по той же причине, что в `test_start_gate.py`: apps.milestones не имеет
права импортировать apps.payments (import-linter, ADR-130), а проверяется
здесь гейт, а не платёжный контур.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.contracts.models import Contract, ContractParty
from apps.milestones import handlers, services
from apps.milestones.models import Milestone
from common.models import OutboxEvent

from ._execution_helpers import (
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
    return make_user("a001")


@pytest.fixture
def contractor():
    return make_user("a002")


@pytest.fixture
def before_start(customer, contractor):
    """Подписанный договор с одним денежным листом и оплатой ДО старта."""
    return make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.BEFORE_START,
    )


def _pay(milestone: Milestone, *, customer, contractor) -> None:
    services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)


def _started_events(milestone: Milestone) -> list[OutboxEvent]:
    return list(
        OutboxEvent.objects.filter(topic="milestone.started", subject__id=str(milestone.id))
    )


# --- Автостарт по каждому пути закрытия последнего условия -----------------


def test_auto_start_on_last_material_received(before_start, customer, contractor):
    """Деньги уже подтверждены — последним закрывается материал."""
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    _pay(milestone, customer=customer, contractor=contractor)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.PENDING

    services.confirm_material_received(material, user=contractor)

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.IN_PROGRESS
    assert milestone.started_at is not None
    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.IN_PROGRESS


def test_auto_start_on_last_payment_confirmed(before_start, customer, contractor):
    """Материал уже получен — последней закрывается оплата (вторая сторона)."""
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    services.confirm_material_received(material, user=contractor)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.PENDING

    services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.PENDING, "одна сторона — ещё не оплата"

    services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.IN_PROGRESS
    assert milestone.started_at is not None


def test_auto_start_on_contract_signed_when_nothing_else_required(customer, contractor):
    """Постоплата наличными и без материалов заказчика: подпись — ЕДИНСТВЕННОЕ
    условие, и лист стартует по событию `contract.signed` (реакция подписчика
    apps.milestones, а не вызова из apps.contracts)."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.AFTER_ACCEPTANCE,
    )
    assert milestone.status == _STATUS.PENDING
    conditions = services.gate_status(milestone)["conditions"]
    assert conditions["materials"] == services.CONDITION_NOT_REQUIRED
    assert conditions["financial"] == services.CONDITION_NOT_REQUIRED

    event = OutboxEvent.objects.filter(
        topic="contract.signed", subject__id=str(contract.id)
    ).first()
    assert event is not None, "подписание публикует contract.signed"
    handlers.handle_contract_signed(event)

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.IN_PROGRESS
    assert milestone.started_at is not None


# --- Запреты: пока условие «Ждём», старта нет ------------------------------


def test_no_auto_start_while_material_is_waiting(before_start, customer, contractor):
    contract, milestone = before_start
    add_customer_material(milestone, received=False)
    _pay(milestone, customer=customer, contractor=contractor)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.PENDING
    assert milestone.started_at is None
    assert _started_events(milestone) == []


def test_no_auto_start_while_payment_is_waiting(before_start, customer, contractor):
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    services.confirm_material_received(material, user=contractor)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.PENDING
    assert _started_events(milestone) == []


def test_no_auto_start_while_contract_is_not_signed(before_start, customer, contractor):
    """Подпись — условие №1: до неё «готово» не бывает ни у чего (ADR-155)."""
    contract, milestone = before_start
    contract.negotiation_status = Contract.NegotiationStatus.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    milestone.refresh_from_db()

    _pay(milestone, customer=customer, contractor=contractor)

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.PENDING
    assert _started_events(milestone) == []


def test_auto_start_does_not_touch_branch(before_start, customer, contractor):
    """Ветка группирует, стартуют ЛИСТЬЯ (домен-инвариант дерева этапов):
    автостарт обязан молча пройти мимо ветки, а не упасть
    `GateNotOnLeafError` и не сорвать подтверждение оплаты."""
    contract, branch = before_start
    branch.amount = None
    branch.amount_currency = None
    branch.save(update_fields=["amount", "amount_currency"])
    leaf = Milestone.objects.create(
        contract=contract,
        parent=branch,
        title="Подэтап",
        amount=Decimal("10000.00"),
        amount_currency="RUB",
    )

    _pay(leaf, customer=customer, contractor=contractor)

    leaf.refresh_from_db()
    branch.refresh_from_db()
    assert leaf.status == _STATUS.IN_PROGRESS
    assert branch.status == _STATUS.PENDING
    assert branch.started_at is None
    assert _started_events(branch) == []


def test_auto_start_ready_leaves_skips_branches(before_start, customer, contractor):
    """Путь подписания перебирает всё дерево — ветки он обязан пропускать."""
    contract, branch = before_start
    branch.amount = None
    branch.amount_currency = None
    branch.save(update_fields=["amount", "amount_currency"])
    leaf = Milestone.objects.create(
        contract=contract,
        parent=branch,
        title="Подэтап",
        amount=Decimal("10000.00"),
        amount_currency="RUB",
    )
    services.confirm_payment(leaf, user=customer, side=_ROLE.CUSTOMER)
    services.confirm_payment(branch, user=customer, side=_ROLE.CUSTOMER)
    services.confirm_payment(branch, user=contractor, side=_ROLE.CONTRACTOR)

    started = services.auto_start_ready_leaves(contract.id)

    assert [m.id for m in started] == [], "лист не оплачен, ветка не стартует никогда"
    branch.refresh_from_db()
    assert branch.status == _STATUS.PENDING


# --- Идемпотентность -------------------------------------------------------


def test_repeated_condition_close_does_not_duplicate_start(before_start, customer, contractor):
    """Повторное закрытие того же условия (двойной клик, ретрай сети) не
    даёт второй пары `gate_passed`/`started`."""
    contract, milestone = before_start
    material = add_customer_material(milestone, received=False)
    _pay(milestone, customer=customer, contractor=contractor)
    services.confirm_material_received(material, user=contractor)
    milestone.refresh_from_db()
    started_at = milestone.started_at

    services.confirm_material_received(material, user=contractor)
    services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)

    milestone.refresh_from_db()
    assert milestone.started_at == started_at
    assert len(_started_events(milestone)) == 1
    assert (
        OutboxEvent.objects.filter(
            topic="milestone.gate_passed", subject__id=str(milestone.id)
        ).count()
        == 1
    )


def test_manual_start_after_auto_start_is_noop(before_start, customer, contractor):
    """Ручной `POST /start` остаётся (обратная совместимость, ADR-162), но
    на уже автостартованном листе — no-op без вторых событий."""
    contract, milestone = before_start
    _pay(milestone, customer=customer, contractor=contractor)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.IN_PROGRESS
    started_at = milestone.started_at

    result = services.start_milestone(milestone, user=customer)

    assert result.status == _STATUS.IN_PROGRESS
    assert result.started_at == started_at
    assert len(_started_events(milestone)) == 1


def test_repeated_contract_signed_delivery_starts_nothing_twice(customer, contractor):
    """At-least-once реле (ADR-064): вторая доставка `contract.signed`
    не находит `pending` листьев и вторых событий не публикует."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.AFTER_ACCEPTANCE,
    )
    event = OutboxEvent.objects.filter(
        topic="contract.signed", subject__id=str(contract.id)
    ).first()
    assert event is not None
    handlers.handle_contract_signed(event)
    handlers.handle_contract_signed(event)

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.IN_PROGRESS
    assert len(_started_events(milestone)) == 1


# --- Событие автостарта отличимо от ручного --------------------------------


def test_auto_start_event_is_marked_and_has_no_actor(before_start, customer, contractor):
    """Старт по системе: `actor` пуст, `payload["auto"] is True`. Пустой
    актор — то, из-за чего уведомление «Этап начался» получают ОБЕ стороны
    (`apps.notifications.subscriber`: у события без актора реестр
    контрагента адресует всех участников договора)."""
    contract, milestone = before_start
    _pay(milestone, customer=customer, contractor=contractor)

    event = _started_events(milestone)[0]
    assert event.actor == {}
    assert event.payload["auto"] is True


def test_manual_start_event_keeps_actor_and_auto_false(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=_ORDER.AFTER_ACCEPTANCE,
    )
    services.start_milestone(milestone, user=customer)

    event = _started_events(milestone)[0]
    assert event.actor == {"user_id": str(customer.id)}
    assert event.payload["auto"] is False
