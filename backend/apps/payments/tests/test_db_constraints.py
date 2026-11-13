"""БД-инварианты `payment` — на ЖИВОМ PostgreSQL (CLAUDE.md: «БД-инварианты
(CHECK/EXCLUDE, триггеры) — на живом PostgreSQL, НЕ на sqlite»).

Проверяется не «сервис бросает исключение» (это test_services.py), а
последний рубеж: строку с такими данными не примет сама база — даже если
её попытается создать миграция данных, скрипт инцидента или будущий код.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction

from apps.payments.models import Payment, ProviderWebhookEvent

from ._helpers import make_signed_contract_with_leaf, make_user

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def leaf():
    contract, milestone = make_signed_contract_with_leaf(
        customer=make_user("db-cst"), contractor=make_user("db-ctr")
    )
    return contract, milestone


def _payment(contract, milestone, **overrides):
    data = {
        "contract": contract,
        "milestone": milestone,
        "kind": Payment.Kind.POSTPAYMENT,
        "method": Payment.Method.CASH,
        "status": Payment.Status.PENDING,
        "amount": Decimal("100.00"),
        "currency": "RUB",
    }
    data.update(overrides)
    return Payment(**data)


def test_amount_must_be_positive(leaf):
    contract, milestone = leaf
    with pytest.raises(IntegrityError, match="payment_amount_positive"), transaction.atomic():
        _payment(contract, milestone, amount=Decimal("0.00")).save()


def test_negative_amount_is_rejected(leaf):
    contract, milestone = leaf
    with pytest.raises(IntegrityError, match="payment_amount_positive"), transaction.atomic():
        _payment(contract, milestone, amount=Decimal("-1.00")).save()


@pytest.mark.parametrize("currency", ["ru", "rub", "R", "R1B"])
def test_currency_must_be_iso4217_uppercase(leaf, currency):
    contract, milestone = leaf
    with pytest.raises(IntegrityError, match="payment_currency_iso4217"), transaction.atomic():
        _payment(contract, milestone, currency=currency).save()


def test_unknown_status_is_rejected(leaf):
    contract, milestone = leaf
    with pytest.raises(IntegrityError, match="payment_status_valid"), transaction.atomic():
        _payment(contract, milestone, status="almost_paid").save()


def test_unknown_kind_is_rejected(leaf):
    contract, milestone = leaf
    with pytest.raises(IntegrityError, match="payment_kind_valid"), transaction.atomic():
        _payment(contract, milestone, kind="tip").save()


def test_unknown_method_is_rejected(leaf):
    contract, milestone = leaf
    with pytest.raises(IntegrityError, match="payment_method_valid"), transaction.atomic():
        _payment(contract, milestone, method="barter").save()


def test_provider_era_statuses_are_allowed_by_the_check(leaf):
    """Статусы провайдерской эры (§5.2.6) недостижимы через FSM, но CHECK их
    пропускает — иначе подключение партнёра потребовало бы менять
    ограничение на живой таблице платежей (см. докстринг models.py)."""
    contract, milestone = leaf
    _payment(contract, milestone, status=Payment.Status.OBSERVED).save()
    assert Payment.objects.filter(status=Payment.Status.OBSERVED).exists()


def test_one_payment_of_a_kind_per_milestone(leaf):
    contract, milestone = leaf
    _payment(contract, milestone).save()
    with pytest.raises(IntegrityError, match="payment_unique_milestone_kind"), transaction.atomic():
        _payment(contract, milestone).save()


def test_two_kinds_coexist_on_one_leaf(leaf):
    """UNIQUE — по ПАРЕ (лист, вид): второй вид на том же листе допустим.
    Домен сейчас создаёт ровно один (`postpayment`, ADR-155), но
    ограничение проверяется само по себе — на зарезервированном
    `prepayment` (частичная предоплата, Р2)."""
    contract, milestone = leaf
    _payment(contract, milestone, kind=Payment.Kind.POSTPAYMENT).save()
    _payment(contract, milestone, kind=Payment.Kind.PREPAYMENT).save()
    assert Payment.objects.filter(milestone=milestone).count() == 2


def test_provider_ref_is_unique_per_provider(leaf):
    contract, milestone = leaf
    _payment(contract, milestone, kind=Payment.Kind.POSTPAYMENT, provider_ref="op-1").save()
    with pytest.raises(IntegrityError, match="payment_unique_provider_ref"), transaction.atomic():
        _payment(contract, milestone, kind=Payment.Kind.PREPAYMENT, provider_ref="op-1").save()


def test_null_provider_ref_does_not_collide(leaf):
    """Условный UNIQUE: у платежей без провайдера ref пустой, и они не
    должны мешать друг другу."""
    contract, milestone = leaf
    _payment(contract, milestone, kind=Payment.Kind.POSTPAYMENT).save()
    _payment(contract, milestone, kind=Payment.Kind.PREPAYMENT).save()
    assert Payment.objects.filter(provider_ref__isnull=True).count() == 2


def test_webhook_event_id_is_unique_per_provider():
    ProviderWebhookEvent.objects.create(provider="manual", event_id="e1")
    with pytest.raises(IntegrityError, match="provider_webhook_unique_event"), transaction.atomic():
        ProviderWebhookEvent.objects.create(provider="manual", event_id="e1")


def test_webhook_event_id_cannot_be_blank():
    with (
        pytest.raises(IntegrityError, match="provider_webhook_event_id_not_blank"),
        transaction.atomic(),
    ):
        ProviderWebhookEvent.objects.create(provider="manual", event_id="")
