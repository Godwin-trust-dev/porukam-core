"""Property-based (Hypothesis) инварианты денег платёжного контура — CLAUDE.md
требует их именно для денег и дерева этапов.

Проверяемое утверждение из docs/plan.md Э5: полностью оплаченный договор
даёт сумму подтверждённых платежей, В ТОЧНОСТИ равную сумме его денежных
листьев — при ЛЮБОМ наборе сумм и любом их количестве. Именно здесь ловятся
ошибки округления и «почти равно», которые на одном примере (10000.00)
никогда не всплывут.

Статус листа проставляется напрямую (`update(status="accepted")`), а не
прогоном сдачи/приёмки: под тестом ДЕНЕЖНАЯ арифметика, а не контур
исполнения (он полностью покрыт apps/milestones/tests/test_execution.py), и
двадцать прогонов загрузки доказательств сделали бы property-тест
неподъёмным по времени.
"""

from __future__ import annotations

import itertools
from decimal import Decimal

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from apps.contracts.models import Contract
from apps.milestones import services as milestones_services
from apps.milestones.models import Milestone
from apps.payments import services
from apps.payments.models import Payment

from ._helpers import make_signed_contract_with_leaf, make_user

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_seq = itertools.count(1)
_AMOUNT = st.decimals(min_value=Decimal("0.01"), max_value=Decimal("99999999.99"), places=2)


def _fresh_signed(method: str = Contract.PaymentMethod.CASH):
    """Договор сразу «в работе»: статусы листьев тесты проставляют напрямую
    (см. докстринг модуля), а `complete_execution` при полной оплате ждёт
    `execution_status=in_progress` — обычно его ставит `start_milestone`,
    которого здесь не было."""
    customer = make_user(f"prop-c{next(_seq)}")
    contractor = make_user(f"prop-r{next(_seq)}")
    contract, leaf = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=method
    )
    Contract.objects.filter(pk=contract.pk).update(
        execution_status=Contract.ExecutionStatus.IN_PROGRESS
    )
    contract.refresh_from_db()
    return contract, leaf, customer, contractor


@given(extra_amounts=st.lists(_AMOUNT, min_size=0, max_size=4), first_amount=_AMOUNT)
@settings(
    max_examples=8,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
def test_fully_paid_contract_matches_the_sum_of_its_money_leaves(extra_amounts, first_amount):
    contract, leaf, customer, contractor = _fresh_signed()
    Milestone.objects.filter(pk=leaf.pk).update(
        amount=first_amount, amount_currency="RUB", status=Milestone.Status.ACCEPTED
    )
    for index, amount in enumerate(extra_amounts, start=1):
        Milestone.objects.create(
            contract=contract,
            title=f"Этап {index}",
            order=index,
            amount=amount,
            amount_currency="RUB",
            status=Milestone.Status.ACCEPTED,
        )

    for milestone in Milestone.objects.filter(contract=contract, amount__isnull=False):
        payment, _ = services.create_payment(milestone, kind=Payment.Kind.POSTPAYMENT)
        services.confirm_by_payer(payment, user=customer)
        services.confirm_by_payee(payment, user=contractor)

    expected = milestones_services.total_leaf_amount(contract)
    actual = services.total_confirmed(contract)
    assert actual is not None
    assert actual.amount == expected.amount
    assert actual.currency == expected.currency
    assert actual.amount == sum(extra_amounts, start=first_amount)


@given(amount=_AMOUNT)
@settings(
    max_examples=8,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
def test_payment_amount_is_the_leaf_amount_without_drift(amount):
    """Комиссии платформы нет (финмодель v2) — платёж РАВЕН сумме листа, а
    не «сумме минус что-то»; ни одного места, где из суммы что-то
    вычитается, в контуре быть не должно."""
    contract, leaf, customer, contractor = _fresh_signed()
    Milestone.objects.filter(pk=leaf.pk).update(
        amount=amount, amount_currency="RUB", status=Milestone.Status.ACCEPTED
    )
    leaf.refresh_from_db()
    payment, _ = services.create_payment(leaf, kind=Payment.Kind.POSTPAYMENT)
    assert payment.amount == leaf.amount
    assert payment.currency == leaf.amount_currency


@given(amount=_AMOUNT)
@settings(
    max_examples=8,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
def test_partially_confirmed_payments_never_count_as_paid(amount):
    """Односторонняя отметка деньгами не является: сумма подтверждённого
    остаётся пустой, пока не подтвердили ОБЕ стороны."""
    contract, leaf, customer, contractor = _fresh_signed()
    Milestone.objects.filter(pk=leaf.pk).update(
        amount=amount, amount_currency="RUB", status=Milestone.Status.ACCEPTED
    )
    leaf.refresh_from_db()
    payment, _ = services.create_payment(leaf, kind=Payment.Kind.POSTPAYMENT)
    services.confirm_by_payer(payment, user=customer)
    assert services.total_confirmed(contract) is None


def test_total_confirmed_is_none_without_payments():
    """Валюты по умолчанию нет (CLAUDE.md) — ноль без валюты не Money."""
    contract, _leaf, _customer, _contractor = _fresh_signed()
    assert services.total_confirmed(contract) is None


@pytest.mark.parametrize("kind", [Payment.Kind.PREPAYMENT, Payment.Kind.POSTPAYMENT])
def test_total_confirmed_does_not_mix_kinds(kind):
    """Разные виды платежа по одному листу — разные деньги; складывать их в
    один итог значило бы удвоить сумму договора. Домен сейчас создаёт один
    вид (`postpayment`, ADR-155), но сам итог обязан считаться по виду —
    иначе зарезервированная частичная предоплата (Р2) молча удвоит суммы."""
    contract, leaf, customer, contractor = _fresh_signed()
    Milestone.objects.filter(pk=leaf.pk).update(status=Milestone.Status.ACCEPTED)
    leaf.refresh_from_db()
    payment, _ = services.create_payment(leaf, kind=kind)
    services.confirm_by_payer(payment, user=customer)
    services.confirm_by_payee(payment, user=contractor)
    assert services.total_confirmed(contract, kind=kind) is not None
    other = Payment.Kind.POSTPAYMENT if kind == Payment.Kind.PREPAYMENT else Payment.Kind.PREPAYMENT
    assert services.total_confirmed(contract, kind=other) is None
