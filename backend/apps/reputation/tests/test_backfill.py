"""`reputation_backfill` (ADR-163 §7) — разовая миграция данных для сделок,
завершившихся ДО раскатки волны 2: старые события новых полей не несут, и
из outbox их не пересобрать.

Проверяется главное свойство команды — ИДЕМПОТЕНТНОСТЬ: счётчики
присваиваются, а не накапливаются, поэтому второй прогон обязан дать тот
же результат, что первый."""

from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command

from apps.contracts.models import ContractParty
from apps.milestones import services as milestones_services
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.reputation.models import DealFact, MilestoneFact
from common import relay

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role


def _completed_contract():
    customer = make_user("bkf001")
    contractor = make_user("bkf002")
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    milestones_services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    milestones_services.accept_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestones_services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    relay.deliver_due_events()
    return contract, milestone


def _run(**options) -> str:
    out = StringIO()
    call_command("reputation_backfill", stdout=out, **options)
    return out.getvalue()


def test_dry_run_writes_nothing():
    contract, _milestone = _completed_contract()
    MilestoneFact.objects.all().delete()
    DealFact.objects.filter(contract_id=contract.id).update(total_amount=None, total_currency=None)

    output = _run(dry_run=True)

    assert "[dry-run]" in output
    assert MilestoneFact.objects.count() == 0
    deal = DealFact.objects.get(contract_id=contract.id)
    assert deal.total_amount is None


def test_backfill_restores_the_deal_total_and_payment_protection():
    contract, _milestone = _completed_contract()
    DealFact.objects.filter(contract_id=contract.id).update(
        total_amount=None, total_currency=None, payment_method="", payment_protected=None
    )

    _run()

    deal = DealFact.objects.get(contract_id=contract.id)
    assert deal.total_amount is not None
    assert deal.total_currency
    assert deal.payment_protected is contract.protected


def test_backfill_rebuilds_milestone_rows_from_the_facade():
    contract, milestone = _completed_contract()
    MilestoneFact.objects.all().delete()

    _run()

    fact = MilestoneFact.objects.get(milestone_id=milestone.id)
    assert str(fact.contract_id) == str(contract.id)
    assert fact.title == milestone.title


def test_running_it_twice_changes_nothing():
    contract, _milestone = _completed_contract()
    _run()
    deal = DealFact.objects.get(contract_id=contract.id)
    first = (
        deal.milestones_on_time,
        deal.milestones_with_due,
        deal.payments_on_time,
        deal.payments_with_due,
        deal.acceptances_prompt,
        deal.acceptances_measured,
        MilestoneFact.objects.count(),
    )

    _run()

    deal.refresh_from_db()
    second = (
        deal.milestones_on_time,
        deal.milestones_with_due,
        deal.payments_on_time,
        deal.payments_with_due,
        deal.acceptances_prompt,
        deal.acceptances_measured,
        MilestoneFact.objects.count(),
    )
    assert first == second


def test_backfill_does_not_erase_history_only_events_carry():
    """ЗАПРЕТ: отклонения и споры — факты ИСТОРИИ, их в состоянии этапа
    нет; бэкфилл обязан оставить накопленное событиями нетронутым."""
    contract, milestone = _completed_contract()
    MilestoneFact.objects.filter(milestone_id=milestone.id).update(
        rejections=2, last_rejection_reason="Швы не затёрты", disputes_opened=1
    )

    _run()

    fact = MilestoneFact.objects.get(milestone_id=milestone.id)
    assert fact.rejections == 2
    assert fact.last_rejection_reason == "Швы не затёрты"
    assert fact.disputes_opened == 1
    assert DealFact.objects.filter(contract_id=contract.id).exists()


def test_deal_without_a_contract_is_skipped_not_crashed():
    DealFact.objects.create(contract_id="018f1a00-0000-7000-8000-00000000dead")

    output = _run()

    assert "пропущено (нет договора): 1" in output
