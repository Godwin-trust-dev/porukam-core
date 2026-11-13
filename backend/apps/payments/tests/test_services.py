"""apps.payments.services — Э5 волна 1 (ADR-130). Каждый переход FSM и
каждый запрет — отдельным тестом (CLAUDE.md)."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.contracts import services as contracts_services
from apps.contracts.models import Contract
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from apps.milestones.models import Milestone
from apps.payments import services
from apps.payments.models import Payment
from apps.payments.providers import PaymentProviderNotConfiguredError
from common import outbox, relay
from common.fsm import InvalidTransitionError
from common.models import OutboxEvent

from ._helpers import accept_leaf, make_signed_contract_with_leaf, make_user

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_METHOD = Contract.PaymentMethod
_STATUS = Payment.Status
_KIND = Payment.Kind


@pytest.fixture
def customer():
    return make_user("p001")


@pytest.fixture
def contractor():
    return make_user("p002")


@pytest.fixture
def outsider():
    return make_user("p003")


@pytest.fixture
def accepted(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.CASH
    )
    accept_leaf(contract, milestone, customer=customer, contractor=contractor)
    return contract, milestone


def _postpayment(contract, milestone) -> Payment:
    payment, _created = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    return payment


def _topics() -> list[str]:
    return list(
        OutboxEvent.objects.order_by("occurred_at", "event_id").values_list("topic", flat=True)
    )


# --- Выставление счёта -----------------------------------------------------


def test_create_payment_takes_amount_and_method_from_the_leaf(accepted):
    contract, milestone = accepted
    payment, created = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    assert created is True
    assert payment.status == _STATUS.PENDING
    assert payment.method == _METHOD.CASH
    assert payment.amount == milestone.amount
    assert payment.currency == milestone.amount_currency
    assert payment.provider == Payment.PROVIDER_MANUAL
    assert "payment.created" in _topics()


def test_create_payment_is_idempotent_by_milestone_and_kind(accepted):
    contract, milestone = accepted
    first, created_first = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    second, created_second = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    assert created_first is True
    assert created_second is False
    assert first.id == second.id
    assert Payment.objects.filter(milestone=milestone, kind=_KIND.POSTPAYMENT).count() == 1
    assert _topics().count("payment.created") == 1


def test_create_payment_anchors_settlement_deadline(accepted):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    deadline = DomainDeadline.objects.get(subject_type="payment", subject_id=payment.id)
    assert deadline.kind == services.PAYMENT_DEADLINE_KIND
    assert deadline.anchor_at is not None
    assert deadline.deadline_at is not None
    expected = DeadlineKindConfig.objects.get(kind=services.PAYMENT_DEADLINE_KIND).duration
    assert deadline.deadline_at - deadline.anchor_at == expected


def test_create_payment_on_branch_is_rejected(customer, contractor):
    """Ветка не оплачивается по инварианту дерева (CLAUDE.md: «ветки
    группируют, ЛИСТЬЯ принимаются/оплачиваются»). Сумму с узла приходится
    снять перед добавлением ребёнка — иначе БД-триггер
    `milestone_amount_guard` не даст превратить лист в ветку."""
    contract, node = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    Milestone.objects.filter(pk=node.pk).update(amount=None, amount_currency=None)
    node.refresh_from_db()
    Milestone.objects.create(
        contract=contract,
        parent=node,
        title="Подэтап",
        order=1,
        amount=Decimal("10000.00"),
        amount_currency="RUB",
    )
    with pytest.raises(services.MilestoneNotPayableError):
        services.create_payment(node, kind=_KIND.POSTPAYMENT)


def test_create_payment_requires_signed_contract(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    contract.negotiation_status = Contract.NegotiationStatus.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    milestone.refresh_from_db()
    with pytest.raises(services.ContractNotSignedError):
        services.create_payment(milestone, kind=_KIND.POSTPAYMENT)


@pytest.mark.parametrize("method", [_METHOD.DIRECT_PLATFORM, _METHOD.HOLD])
def test_create_payment_without_partner_is_rejected(customer, contractor, method):
    """ЧЕСТНАЯ заглушка (ADR-130): партнёра нет — счёт не выставляется, а не
    «выставляется и висит вечно»."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=method
    )
    with pytest.raises(PaymentProviderNotConfiguredError):
        services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    assert not Payment.objects.exists()


def test_ensure_contract_payments_skips_provider_methods(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.HOLD
    )
    assert services.ensure_contract_payments(contract) == []


def test_ensure_contract_payments_skips_unaccepted_leaf_at_after_acceptance(customer, contractor):
    """Постоплата: счёт появляется только у листа, дошедшего до приёмки.
    (До ADR-155 этот же тест проверял аванс у способа `prepayment` —
    способа больше нет, предоплата переехала в `payment_order`, см. раздел
    ADR-155 ниже.)"""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.CASH
    )
    assert services.ensure_contract_payments(contract) == []
    assert not Payment.objects.filter(kind=_KIND.POSTPAYMENT).exists()


def test_ensure_contract_payments_is_idempotent(accepted):
    contract, milestone = accepted
    services.ensure_contract_payments(contract)
    services.ensure_contract_payments(contract)
    assert Payment.objects.count() == 1


# --- FSM: разрешённые переходы ---------------------------------------------


def test_confirm_payer_moves_pending_to_payer_confirmed(accepted, customer):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    result = services.confirm_by_payer(payment, user=customer)
    assert result.status == _STATUS.PAYER_CONFIRMED
    assert result.payer_confirmed_at is not None
    assert "payment.payer_confirmed" in _topics()
    assert "payment.paid" not in _topics()


def test_confirm_payee_moves_pending_to_payee_confirmed(accepted, contractor):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    result = services.confirm_by_payee(payment, user=contractor)
    assert result.status == _STATUS.PAYEE_CONFIRMED
    assert result.payee_confirmed_at is not None


def test_confirm_payer_then_payee_reaches_confirmed(accepted, customer, contractor):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.confirm_by_payer(payment, user=customer)
    result = services.confirm_by_payee(payment, user=contractor)
    assert result.status == _STATUS.CONFIRMED
    assert "payment.paid" in _topics()


def test_confirm_payee_then_payer_reaches_confirmed(accepted, customer, contractor):
    """Порядок сторон не задан доменом — второй «полупуть» FSM."""
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.confirm_by_payee(payment, user=contractor)
    result = services.confirm_by_payer(payment, user=customer)
    assert result.status == _STATUS.CONFIRMED


def test_cancel_moves_pending_to_cancelled(accepted, customer):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    result = services.cancel_payment(payment, user=customer, reason="счёт задвоился")
    assert result.status == _STATUS.CANCELLED
    assert result.cancelled_at is not None
    assert result.cancel_reason == "счёт задвоился"
    assert "payment.cancelled" in _topics()


# --- FSM: запреты ----------------------------------------------------------


def test_confirm_payer_twice_is_noop_not_conflict(accepted, customer):
    """Двойной клик/ретрай сети не должен превращаться в 409 — контракт
    унаследованного эндпоинта это гарантировал и до Э5."""
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    first = services.confirm_by_payer(payment, user=customer)
    stamp = first.payer_confirmed_at
    again = services.confirm_by_payer(payment, user=customer)
    assert again.status == _STATUS.PAYER_CONFIRMED
    assert again.payer_confirmed_at == stamp
    assert _topics().count("payment.payer_confirmed") == 1


def test_confirm_after_confirmed_is_invalid_transition(accepted, customer, contractor):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.confirm_by_payer(payment, user=customer)
    services.confirm_by_payee(payment, user=contractor)
    payment.payer_confirmed_at = None  # обходим no-op, чтобы дойти до FSM
    with pytest.raises(InvalidTransitionError):
        services.confirm_by_payer(payment, user=customer)


def test_confirm_after_cancelled_is_invalid_transition(accepted, customer):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.cancel_payment(payment, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.confirm_by_payer(payment, user=customer)


def test_cancel_after_partial_confirmation_is_invalid_transition(accepted, customer):
    """Отменить можно только счёт, которого никто ещё не касался деньгами:
    иначе отмена молча стёрла бы уже зафиксированное подтверждение."""
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.confirm_by_payer(payment, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.cancel_payment(payment, user=customer)


def test_cancel_twice_is_invalid_transition(accepted, customer):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.cancel_payment(payment, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.cancel_payment(payment, user=customer)


def test_cancel_before_start_invoice_is_forbidden(customer, contractor):
    """ADR-132 + ADR-155: счёт «до начала этапа» — условие гейта §6.3, а
    `UNIQUE (milestone, kind)` не даёт выставить его заново; отмена заперла
    бы старт навсегда. Запрет по УСЛОВИЯМ ДОГОВОРА, до FSM: статус остаётся
    `pending`, события `payment.cancelled` нет. (До ADR-155 то же правило
    жило на виде платежа `advance`.)"""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    for user in (customer, contractor):
        with pytest.raises(services.PaymentNotCancellableError):
            services.cancel_payment(payment, user=user, reason="передумал")
    payment.refresh_from_db()
    assert payment.status == _STATUS.PENDING
    assert payment.cancelled_at is None
    assert "payment.cancelled" not in _topics()


def test_cancel_before_start_invoice_by_outsider_is_still_403_not_409(
    customer, contractor, outsider
):
    """Порядок проверок: сначала «сторона ли», потом «отменяем ли вообще» —
    чужак не должен по коду ошибки узнавать условия договора."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    with pytest.raises(contracts_services.NotAPartyError):
        services.cancel_payment(payment, user=outsider)


def test_payer_cannot_confirm_as_payee(accepted, customer):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    with pytest.raises(services.PaymentSideMismatchError):
        services.confirm_by_payee(payment, user=customer)


def test_payee_cannot_confirm_as_payer(accepted, contractor):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    with pytest.raises(services.PaymentSideMismatchError):
        services.confirm_by_payer(payment, user=contractor)


def test_explicit_side_must_match_the_caller(accepted, customer):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    with pytest.raises(services.PaymentSideMismatchError):
        services.confirm(payment, user=customer, side="payee")


def test_outsider_cannot_touch_the_payment(accepted, outsider):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    with pytest.raises(contracts_services.NotAPartyError):
        services.confirm(payment, user=outsider)
    with pytest.raises(contracts_services.NotAPartyError):
        services.cancel_payment(payment, user=outsider)


# --- Зеркало в apps.milestones (гейт §6.3 и accepted -> paid) --------------


def test_confirmed_postpayment_moves_the_leaf_to_paid_and_completes_contract(
    accepted, customer, contractor
):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.confirm_by_payer(payment, user=customer)
    milestone.refresh_from_db()
    assert milestone.status == Milestone.Status.ACCEPTED  # ещё не обе стороны

    services.confirm_by_payee(payment, user=contractor)
    milestone.refresh_from_db()
    assert milestone.status == Milestone.Status.PAID
    assert milestone.paid_confirmed_by_customer_at is not None
    assert milestone.paid_confirmed_by_contractor_at is not None
    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.WARRANTY


def test_confirmed_before_start_payment_opens_the_gate(customer, contractor):
    """Сквозной путь «настоящий Payment -> зеркало -> гейт» (ADR-155; до
    него ту же роль играл подтверждённый аванс способа `prepayment`)."""
    from apps.milestones import services as milestones_services

    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    with pytest.raises(milestones_services.GateFinancialConditionNotMetError):
        milestones_services.start_milestone(milestone, user=customer)

    services.confirm_by_payer(payment, user=customer)
    services.confirm_by_payee(payment, user=contractor)
    milestone.refresh_from_db()
    assert milestones_services.gate_status(milestone)["financial_condition_met"] is True
    started = milestones_services.start_milestone(milestone, user=customer)
    assert started.status == Milestone.Status.IN_PROGRESS


def test_postpayment_before_acceptance_cannot_be_confirmed(customer, contractor):
    """Постоплата по непринятому листу — 409 от FSM ЭТАПА: `pay` возможен
    только из `accepted` (tech-spec.md §6.3)."""
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    with pytest.raises(InvalidTransitionError):
        services.confirm_by_payer(payment, user=customer)


# --- Просрочка -------------------------------------------------------------


def test_settlement_deadline_sweep_publishes_payment_overdue(accepted):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    deadline = DomainDeadline.objects.get(subject_type="payment", subject_id=payment.id)
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])

    assert deadlines_tasks.sweep_domain_deadlines() >= 1
    relay.deliver_due_events()

    payment.refresh_from_db()
    assert payment.overdue_at is not None
    assert payment.status == _STATUS.PENDING  # просрочка не отменяет обязательство
    assert "payment.overdue" in _topics()


def test_mark_overdue_is_idempotent(accepted):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    assert services.mark_overdue(payment) is True
    assert services.mark_overdue(payment) is False
    assert _topics().count("payment.overdue") == 1


def test_confirmed_payment_is_never_marked_overdue(accepted, customer, contractor):
    contract, milestone = accepted
    payment = _postpayment(contract, milestone)
    services.confirm_by_payer(payment, user=customer)
    services.confirm_by_payee(payment, user=contractor)
    assert services.mark_overdue(payment) is False


# --- Подписчики outbox -----------------------------------------------------


def test_milestone_accepted_event_issues_the_invoice(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    accept_leaf(contract, milestone, customer=customer, contractor=contractor)
    relay.deliver_due_events()
    payment = Payment.objects.get(milestone=milestone, kind=_KIND.POSTPAYMENT)
    assert payment.status == _STATUS.PENDING


def test_redelivered_accepted_event_does_not_duplicate_the_invoice(customer, contractor):
    """Реле доставляет at-least-once (ADR-064) — идемпотентность подписчика
    держит UNIQUE (milestone, kind), а не память обработчика."""
    from apps.payments import handlers

    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    accept_leaf(contract, milestone, customer=customer, contractor=contractor)
    event = OutboxEvent.objects.filter(topic="milestone.accepted").get()
    handlers.handle_event(event)
    handlers.handle_event(event)
    assert Payment.objects.filter(milestone=milestone, kind=_KIND.POSTPAYMENT).count() == 1


def test_accepted_event_without_partner_does_not_fail_delivery(customer, contractor):
    """Иначе событие ушло бы в вечный ретрай и заблокировало остальных
    подписчиков темы (apps.reputation в том же списке)."""
    from apps.payments import handlers

    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.DIRECT_PLATFORM
    )
    milestone.status = Milestone.Status.ACCEPTED
    milestone.save(update_fields=["status"])
    event = outbox.publish(
        "milestone.accepted",
        subject={"type": "milestone", "id": str(milestone.id)},
        payload={"contract_id": str(contract.id)},
        actor={},
    )
    handlers.handle_event(event)  # не бросает
    assert not Payment.objects.exists()


def test_contract_signed_event_issues_invoices_at_before_start(customer, contractor):
    """Вторая подпись выставляет счета по всем денежным листьям, если
    порядок оплаты `before_start` (до ADR-155 то же делали авансы способа
    `prepayment`)."""
    from apps.payments import handlers

    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    event = outbox.publish(
        "contract.signed",
        subject={"type": "contract", "id": str(contract.id)},
        payload={},
        actor={},
    )
    handlers.handle_event(event)
    assert Payment.objects.filter(milestone=milestone, kind=_KIND.POSTPAYMENT).exists()


# --- ADR-155: оплата ДО начала этапа (`payment_order=before_start`) ---------


@pytest.fixture
def before_start_contract(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    return contract, milestone


def test_ensure_payments_issues_invoice_for_pending_leaf_at_before_start(before_start_contract):
    """Счёт — условие старта, значит существовать он обязан РАНЬШЕ, чем
    лист попробует стартовать (до ADR-155 постоплата выставлялась только
    листу в `accepted`/`paid`)."""
    contract, milestone = before_start_contract
    assert milestone.status == Milestone.Status.PENDING
    payments = services.ensure_contract_payments(contract)
    assert [p.kind for p in payments] == [_KIND.POSTPAYMENT]
    assert payments[0].milestone_id == milestone.id
    assert payments[0].status == _STATUS.PENDING


def test_no_second_invoice_after_acceptance_at_before_start(
    before_start_contract, customer, contractor
):
    """После приёмки предоплаченного листа второй счёт не появляется:
    платёж по листу ОДИН, вид у него один, а `UNIQUE (milestone, kind)`
    делает повторный вызов идемпотентным. Платить дважды никто не должен
    (ADR-155)."""
    contract, milestone = before_start_contract
    payment = services.ensure_contract_payments(contract)[0]
    services.confirm_by_payer(payment, user=customer)
    services.confirm_by_payee(payment, user=contractor)
    milestone.refresh_from_db()

    accept_leaf(contract, milestone, customer=customer, contractor=contractor)
    services.ensure_contract_payments(contract)
    assert Payment.objects.filter(milestone=milestone).count() == 1
    milestone.refresh_from_db()
    assert milestone.status == Milestone.Status.PAID


def test_before_start_invoice_is_not_cancellable(before_start_contract, customer):
    """Дубль-проверка через `ensure_contract_payments` (счёт, выставленный
    подписанием, а не тестом напрямую) — отменить его нельзя."""
    contract, milestone = before_start_contract
    payment = services.ensure_contract_payments(contract)[0]
    with pytest.raises(services.PaymentNotCancellableError):
        services.cancel_payment(payment, user=customer)
