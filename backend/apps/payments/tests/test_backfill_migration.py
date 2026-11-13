"""apps.payments.migrations.0002_backfill_from_milestone_confirmations —
перенос уже состоявшихся денежных фактов в модель `Payment` (ADR-130).

К моменту прогона тестов миграция уже применена к тестовой БД, но применена
«в вакууме»: договоров с подтверждённой оплатой в этот момент не существует
(их создают только тесты, позже). Поэтому тест воссоздаёт прод-ситуацию
вручную и вызывает функцию миграции НАПРЯМУЮ — тот же приём и та же причина,
что в apps/milestones/tests/test_sphere_dedupe_migration.py: это ровно та
функция, что выполнит `manage.py migrate`, а не её копия.

Проверяется главное: договор, где стороны уже подтвердили оплату ДО
выкладки, не «сбрасывается» в новый неоплаченный счёт — иначе людям
пришлось бы подтверждать заново, а лента ЛК (юрканал) сообщила бы им о
счёте по давно закрытому этапу.
"""

from __future__ import annotations

import importlib

import pytest
from django.apps import apps as live_apps
from django.utils import timezone

from apps.contracts.models import Contract
from apps.deadlines.models import DomainDeadline
from apps.milestones.models import Milestone
from apps.payments.models import Payment
from common.models import OutboxEvent

from ._helpers import make_signed_contract_with_leaf, make_user

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_migration = importlib.import_module(
    "apps.payments.migrations.0002_backfill_from_milestone_confirmations"
)

_METHOD = Contract.PaymentMethod


def _run() -> None:
    _migration.backfill(live_apps, None)


@pytest.fixture
def leaf():
    contract, milestone = make_signed_contract_with_leaf(
        customer=make_user("bf-cst"), contractor=make_user("bf-ctr"), payment_method=_METHOD.CASH
    )
    return contract, milestone


def test_fully_paid_leaf_becomes_a_confirmed_payment(leaf):
    contract, milestone = leaf
    now = timezone.now()
    Milestone.objects.filter(pk=milestone.pk).update(
        status=Milestone.Status.PAID,
        paid_confirmed_by_customer_at=now,
        paid_confirmed_by_contractor_at=now,
    )
    _run()
    payment = Payment.objects.get(milestone=milestone, kind=Payment.Kind.POSTPAYMENT)
    assert payment.status == Payment.Status.CONFIRMED
    assert payment.amount == milestone.amount
    assert payment.currency == milestone.amount_currency
    assert payment.method == _METHOD.CASH
    assert payment.payer_confirmed_at == now
    assert payment.payee_confirmed_at == now


def test_paid_leaf_without_marks_is_still_confirmed(leaf):
    """`status=paid` юридически старше отметок: единственный путь в него до
    ADR-130 шёл через двустороннее подтверждение."""
    contract, milestone = leaf
    Milestone.objects.filter(pk=milestone.pk).update(status=Milestone.Status.PAID)
    _run()
    payment = Payment.objects.get(milestone=milestone, kind=Payment.Kind.POSTPAYMENT)
    assert payment.status == Payment.Status.CONFIRMED


def test_half_confirmed_leaf_keeps_the_side_that_already_confirmed(leaf):
    contract, milestone = leaf
    now = timezone.now()
    Milestone.objects.filter(pk=milestone.pk).update(
        status=Milestone.Status.ACCEPTED, paid_confirmed_by_customer_at=now
    )
    _run()
    payment = Payment.objects.get(milestone=milestone, kind=Payment.Kind.POSTPAYMENT)
    assert payment.status == Payment.Status.PAYER_CONFIRMED
    assert payment.payer_confirmed_at == now
    assert payment.payee_confirmed_at is None


def test_contractor_only_confirmation_maps_to_payee(leaf):
    contract, milestone = leaf
    now = timezone.now()
    Milestone.objects.filter(pk=milestone.pk).update(
        status=Milestone.Status.ACCEPTED, paid_confirmed_by_contractor_at=now
    )
    _run()
    payment = Payment.objects.get(milestone=milestone, kind=Payment.Kind.POSTPAYMENT)
    assert payment.status == Payment.Status.PAYEE_CONFIRMED


def test_accepted_leaf_without_marks_gets_a_pending_invoice(leaf):
    contract, milestone = leaf
    Milestone.objects.filter(pk=milestone.pk).update(status=Milestone.Status.ACCEPTED)
    _run()
    payment = Payment.objects.get(milestone=milestone, kind=Payment.Kind.POSTPAYMENT)
    assert payment.status == Payment.Status.PENDING


def test_leaf_not_yet_accepted_is_not_invoiced(leaf):
    contract, milestone = leaf
    assert milestone.status == Milestone.Status.PENDING
    _run()
    assert not Payment.objects.filter(kind=Payment.Kind.POSTPAYMENT).exists()


# ADR-155: тест «договор со способом prepayment получает аванс с его
# отметками» удалён вместе со способом и видом платежа `advance`. Ветка
# бэкфилла в самой миграции 0002 ОСТАЛАСЬ — она историческая и обязана
# отработать на БД, накопленной до ADR-155; воспроизвести её входные данные
# из текущих моделей больше нечем (полей `advance_confirmed_*` нет).


def test_provider_method_contracts_are_skipped():
    """По `direct_platform`/`hold` платежей не было и быть не могло — гейт
    их не пропускал; выдумывать записи не из чего."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=make_user("bf-dp-c"),
        contractor=make_user("bf-dp-r"),
        payment_method=_METHOD.DIRECT_PLATFORM,
    )
    Milestone.objects.filter(pk=milestone.pk).update(status=Milestone.Status.PAID)
    _run()
    assert not Payment.objects.exists()


def test_unsigned_contract_is_skipped(leaf):
    contract, milestone = leaf
    Milestone.objects.filter(pk=milestone.pk).update(status=Milestone.Status.ACCEPTED)
    Contract.objects.filter(pk=contract.pk).update(
        negotiation_status=Contract.NegotiationStatus.UNDER_REVIEW
    )
    _run()
    assert not Payment.objects.exists()


def test_backfill_is_idempotent(leaf):
    contract, milestone = leaf
    Milestone.objects.filter(pk=milestone.pk).update(status=Milestone.Status.PAID)
    _run()
    _run()
    assert Payment.objects.filter(milestone=milestone).count() == 1


def test_backfill_publishes_no_events_and_creates_no_deadlines(leaf):
    """Исторические факты не рассылаются: событие в outbox превратилось бы в
    уведомление «выставлен счёт» по закрытому этапу, а дедлайн оплаты — в
    просрочку по уже оплаченному (см. докстринг миграции)."""
    contract, milestone = leaf
    Milestone.objects.filter(pk=milestone.pk).update(status=Milestone.Status.PAID)
    before = OutboxEvent.objects.count()
    _run()
    assert OutboxEvent.objects.count() == before
    assert not DomainDeadline.objects.filter(subject_type="payment").exists()


def test_gate_keeps_working_on_a_backfilled_paid_leaf(leaf):
    """Смысл всей миграции: после переноса контур не требует от людей
    подтверждать оплату повторно."""
    from apps.payments import services

    contract, milestone = leaf
    now = timezone.now()
    Milestone.objects.filter(pk=milestone.pk).update(
        status=Milestone.Status.PAID,
        paid_confirmed_by_customer_at=now,
        paid_confirmed_by_contractor_at=now,
    )
    _run()
    services.ensure_contract_payments(contract)
    payments = Payment.objects.filter(milestone=milestone)
    assert payments.count() == 1
    assert payments.get().status == Payment.Status.CONFIRMED
