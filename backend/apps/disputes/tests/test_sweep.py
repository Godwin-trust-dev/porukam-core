"""Свип доменных дедлайнов на контуре разногласий (ADR-019 окна, ADR-020
потолок 30 дней; ADR-131). Время не ждём — сдвигаем `deadline_at` в прошлое,
тот же приём, что apps/milestones/tests/test_execution.py."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.contracts import services as contracts_services
from apps.contracts.models import Contract
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DomainDeadline
from apps.disputes import services
from apps.disputes.models import Dispute, DisputeWindow
from apps.milestones.models import Milestone
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from common import relay

from ._helpers import open_milestone_dispute, submit_milestone_with_evidence

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("s001")


@pytest.fixture
def contractor():
    return make_user("s002")


@pytest.fixture
def dispute(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    return open_milestone_dispute(contract, milestone, customer=customer, contractor=contractor)


def _fire(deadline: DomainDeadline) -> None:
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    relay.deliver_due_events()
    relay.deliver_due_events()


def _deadline(kind: str, *, subject_type: str, subject_id) -> DomainDeadline:
    return DomainDeadline.objects.get(kind=kind, subject_type=subject_type, subject_id=subject_id)


# --- Потолок 30 дней (ADR-020) --------------------------------------------


def test_cap_sweep_resolves_dispute_and_leaves_milestone_unpaid(dispute):
    _fire(_deadline("dispute_cap", subject_type="dispute", subject_id=dispute.id))
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.resolution_type == "cap_reached"
    assert dispute.outcome == Dispute.Outcome.CAP_REACHED
    # ADR-020: «спорный этап целиком остаётся неоплаченным» — в accepted он
    # НЕ уходит (apps.milestones.handlers пропускает cap_reached).
    milestone = Milestone.objects.get(pk=dispute.milestone_id)
    assert milestone.status == Milestone.Status.DISPUTED


def test_cap_sweep_from_awaiting_fix_also_closes(dispute, customer):
    services.request_fix(dispute, user=customer)
    dispute.refresh_from_db()
    _fire(_deadline("dispute_cap", subject_type="dispute", subject_id=dispute.id))
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.outcome == Dispute.Outcome.CAP_REACHED


def test_cap_sweep_on_resolved_dispute_is_noop(dispute, contractor):
    services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    dispute.refresh_from_db()
    resolved_at = dispute.resolved_at
    _fire(_deadline("dispute_cap", subject_type="dispute", subject_id=dispute.id))
    dispute.refresh_from_db()
    assert dispute.resolution_type == "accepted"
    assert dispute.resolved_at == resolved_at


# --- Окно ответа (ADR-019) -------------------------------------------------


def test_response_window_is_anchored_by_cabinet_placement(dispute):
    """ADR-057: окно не тикает, пока уведомление не размещено в ЛК. Реле уже
    прогнали в `open_milestone_dispute`, значит уведомление размещено и
    дедлайн заякорен."""
    deadline = _deadline("dispute_response_window", subject_type="dispute", subject_id=dispute.id)
    assert deadline.anchor_at is not None
    assert deadline.deadline_at is not None


def test_response_window_sweep_marks_uncontested(dispute):
    window = dispute.windows.get()
    _fire(_deadline("dispute_response_window", subject_type="dispute", subject_id=dispute.id))
    window.refresh_from_db()
    dispute.refresh_from_db()
    assert window.contested is False
    assert window.closed_at is not None
    assert dispute.status == Dispute.Status.OPEN


def test_answered_window_is_paused_and_sweep_does_not_touch_it(dispute, contractor):
    services.respond_to_dispute(dispute, user=contractor, comment="возражаю", evidence=[])
    window = dispute.windows.get()
    contested_at = window.contested_at
    deadline = _deadline("dispute_response_window", subject_type="dispute", subject_id=dispute.id)
    assert deadline.paused is True
    _fire(deadline)
    window.refresh_from_db()
    assert window.contested is True
    assert window.contested_at == contested_at


# --- Окно оспаривания расторжения (ADR-028) --------------------------------


def test_termination_by_contractor_opens_dispute_window(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    submit_milestone_with_evidence(contract, milestone, customer=customer, contractor=contractor)
    contracts_services.terminate_by_contractor(
        contract, user=contractor, reason="заказчик не даёт доступ"
    )
    relay.deliver_due_events()
    window = DisputeWindow.objects.get(
        contract=contract, kind=DisputeWindow.Kind.TERMINATION_NOTICE
    )
    assert window.dispute_id is None
    assert window.subject_ref == {"type": "contract", "id": str(contract.id)}


def test_termination_by_customer_opens_no_window(customer, contractor):
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    contracts_services.terminate_by_customer(contract, user=customer, reason="передумал")
    relay.deliver_due_events()
    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.TERMINATED_BY_CUSTOMER
    assert not DisputeWindow.objects.filter(contract=contract).exists()


def test_termination_window_contested_by_customer(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    submit_milestone_with_evidence(contract, milestone, customer=customer, contractor=contractor)
    contracts_services.terminate_by_contractor(contract, user=contractor, reason="нет доступа")
    relay.deliver_due_events()
    window = DisputeWindow.objects.get(
        contract=contract, kind=DisputeWindow.Kind.TERMINATION_NOTICE
    )
    services.contest_window(window, user=customer, comment="доступ был")
    window.refresh_from_db()
    assert window.contested is True
    assert window.contested_by_id == customer.id


def test_termination_window_sweep_marks_uncontested(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    submit_milestone_with_evidence(contract, milestone, customer=customer, contractor=contractor)
    contracts_services.terminate_by_contractor(contract, user=contractor, reason="нет доступа")
    relay.deliver_due_events()
    window = DisputeWindow.objects.get(
        contract=contract, kind=DisputeWindow.Kind.TERMINATION_NOTICE
    )
    _fire(_deadline("termination_dispute_window", subject_type="contract", subject_id=contract.id))
    window.refresh_from_db()
    assert window.contested is False


# --- Раунд исправления возвращает этап на приёмку (tech-spec.md §8.8) ------


def test_resubmit_fix_returns_milestone_to_under_acceptance(dispute, customer, contractor):
    fix_request = services.request_fix(dispute, user=customer)
    services.resubmit_fix(fix_request, user=contractor, comment="исправил")
    relay.deliver_due_events()
    milestone = Milestone.objects.get(pk=dispute.milestone_id)
    assert milestone.status == Milestone.Status.UNDER_ACCEPTANCE
    # Новое окно приёмки заведено заново — иначе автоприёмки после
    # исправления не случилось бы никогда.
    assert (
        DomainDeadline.objects.filter(
            kind="milestone_acceptance", subject_type="milestone", subject_id=milestone.id
        ).count()
        == 2
    )


def test_auto_acceptance_after_fix_round(dispute, customer, contractor):
    fix_request = services.request_fix(dispute, user=customer)
    services.resubmit_fix(fix_request, user=contractor)
    relay.deliver_due_events()
    milestone = Milestone.objects.get(pk=dispute.milestone_id)
    deadline = (
        DomainDeadline.objects.filter(
            kind="milestone_acceptance",
            subject_type="milestone",
            subject_id=milestone.id,
            fired_at__isnull=True,
            anchor_at__isnull=False,
        )
        .order_by("-anchor_at")
        .first()
    )
    assert deadline is not None
    _fire(deadline)
    milestone.refresh_from_db()
    assert milestone.status == Milestone.Status.ACCEPTED
