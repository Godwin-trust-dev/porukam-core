"""БД-инварианты контура разногласий — на ЖИВОМ PostgreSQL (CLAUDE.md:
«CHECK/EXCLUDE, триггеры — не на sqlite»). Сервисы проверяют то же самое до
записи ради читаемых 4xx; здесь — последний рубеж."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.contracts.models import Amendment
from apps.disputes.models import DiscountAgreement, Dispute, DisputeWindow, FixRequest
from apps.milestones.tests._execution_helpers import (
    add_checklist_item_with_evidence,
    make_signed_contract_with_leaf,
    make_user,
)

from ._helpers import open_milestone_dispute

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("m001")


@pytest.fixture
def contractor():
    return make_user("m002")


@pytest.fixture
def dispute(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    return open_milestone_dispute(contract, milestone, customer=customer, contractor=contractor)


def test_fix_rounds_cap_is_enforced_by_db(dispute):
    dispute.fix_rounds_used = 3
    with pytest.raises(IntegrityError), transaction.atomic():
        dispute.save(update_fields=["fix_rounds_used"])


def test_fix_request_round_above_cap_is_rejected_by_db(dispute, customer):
    with pytest.raises(IntegrityError), transaction.atomic():
        FixRequest.objects.create(dispute=dispute, round=3, requested_by=customer)


def test_fix_request_round_is_unique_per_dispute(dispute, customer):
    FixRequest.objects.create(dispute=dispute, round=1, requested_by=customer)
    with pytest.raises(IntegrityError), transaction.atomic():
        FixRequest.objects.create(dispute=dispute, round=1, requested_by=customer)


def test_milestone_dispute_without_checklist_item_is_rejected_by_db(dispute):
    """ADR-017: «нет пункта -> нечего оспаривать» — БД тоже это знает."""
    dispute.checklist_item = None
    with pytest.raises(IntegrityError), transaction.atomic():
        dispute.save(update_fields=["checklist_item"])


def test_warranty_dispute_with_milestone_is_rejected_by_db(dispute):
    dispute.kind = Dispute.Kind.WARRANTY
    with pytest.raises(IntegrityError), transaction.atomic():
        dispute.save(update_fields=["kind"])


def test_resolved_dispute_without_outcome_is_rejected_by_db(dispute):
    dispute.status = Dispute.Status.RESOLVED
    dispute.resolved_at = timezone.now()
    with pytest.raises(IntegrityError), transaction.atomic():
        dispute.save(update_fields=["status", "resolved_at"])


def test_open_dispute_with_outcome_is_rejected_by_db(dispute):
    dispute.outcome = Dispute.Outcome.RESOLVED
    with pytest.raises(IntegrityError), transaction.atomic():
        dispute.save(update_fields=["outcome"])


def test_dispute_milestone_from_other_contract_is_rejected_by_trigger(dispute, customer):
    """Триггер `dispute_milestone_contract_guard`: CHECK такое выразить не
    может (условие ссылается на другую таблицу)."""
    _other_contract, other_milestone = make_signed_contract_with_leaf(
        customer=make_user("m003"), contractor=make_user("m004")
    )
    dispute.milestone = other_milestone
    with (
        pytest.raises(IntegrityError, match="dispute_milestone_contract_guard"),
        transaction.atomic(),
    ):
        dispute.save(update_fields=["milestone"])


def test_dispute_checklist_item_from_other_milestone_is_rejected_by_trigger(dispute):
    _other_contract, other_milestone = make_signed_contract_with_leaf(
        customer=make_user("m005"), contractor=make_user("m006")
    )
    dispute.checklist_item = add_checklist_item_with_evidence(other_milestone)
    with (
        pytest.raises(IntegrityError, match="dispute_milestone_contract_guard"),
        transaction.atomic(),
    ):
        dispute.save(update_fields=["checklist_item"])


def _discount_kwargs(dispute, user) -> dict:
    amendment = Amendment.objects.create(
        contract=dispute.contract, order=99, reason="ручной", created_by=user
    )
    return {
        "dispute": dispute,
        "amendment": amendment,
        "milestone": dispute.milestone,
        "proposed_by": user,
        "old_amount": Decimal("10000.00"),
        "old_amount_currency": "RUB",
        "anti_waiver_note": "оговорка",
    }


def test_discount_not_below_current_amount_is_rejected_by_db(dispute, contractor):
    kwargs = _discount_kwargs(dispute, contractor)
    with pytest.raises(IntegrityError), transaction.atomic():
        DiscountAgreement.objects.create(
            **kwargs, new_amount=Decimal("10000.00"), new_amount_currency="RUB"
        )


def test_discount_in_other_currency_is_rejected_by_db(dispute, contractor):
    kwargs = _discount_kwargs(dispute, contractor)
    with pytest.raises(IntegrityError), transaction.atomic():
        DiscountAgreement.objects.create(
            **kwargs, new_amount=Decimal("100.00"), new_amount_currency="USD"
        )


def test_negative_discount_is_rejected_by_db(dispute, contractor):
    kwargs = _discount_kwargs(dispute, contractor)
    with pytest.raises(IntegrityError), transaction.atomic():
        DiscountAgreement.objects.create(
            **kwargs, new_amount=Decimal("-1.00"), new_amount_currency="RUB"
        )


def test_window_outcome_without_closed_at_is_rejected_by_db(dispute):
    window = dispute.windows.get()
    window.contested = False
    with pytest.raises(IntegrityError), transaction.atomic():
        window.save(update_fields=["contested"])


def test_contested_window_without_author_is_rejected_by_db(dispute):
    window = dispute.windows.get()
    window.contested = True
    window.closed_at = timezone.now()
    with pytest.raises(IntegrityError), transaction.atomic():
        window.save(update_fields=["contested", "closed_at"])


def test_window_closed_without_outcome_is_allowed(dispute):
    """Досрочное снятие окна (спор урегулирован раньше срока): `closed_at`
    есть, исхода нет — это ЛЕГАЛЬНОЕ состояние, а не дыра в констрейнте."""
    window = dispute.windows.get()
    window.closed_at = timezone.now()
    window.save(update_fields=["closed_at"])
    window.refresh_from_db()
    assert window.contested is None
    assert DisputeWindow.objects.filter(pk=window.id, closed_at__isnull=False).exists()
