"""apps.disputes.services — этап 7 (ADR-131). Каждый переход FSM и каждый
запрет — отдельным тестом (CLAUDE.md)."""

from __future__ import annotations

import pytest

from apps.contracts import services as contracts_services
from apps.disputes import services
from apps.disputes.models import Dispute, DisputeWindow
from apps.milestones.tests._execution_helpers import (
    add_checklist_item_with_evidence,
    make_signed_contract_with_leaf,
    make_user,
)
from common.models import OutboxEvent

from ._helpers import make_warranty_contract, open_milestone_dispute

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_STATUS = Dispute.Status


@pytest.fixture
def customer():
    return make_user("d001")


@pytest.fixture
def contractor():
    return make_user("d002")


@pytest.fixture
def dispute(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    return open_milestone_dispute(contract, milestone, customer=customer, contractor=contractor)


# --- Открытие (ADR-017) ----------------------------------------------------


def test_open_dispute_checklist_item_from_another_milestone_is_forbidden(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    _contract2, milestone2 = make_signed_contract_with_leaf(
        customer=make_user("d003"), contractor=make_user("d004")
    )
    item = add_checklist_item_with_evidence(milestone2)
    with pytest.raises(services.ChecklistItemNotOnMilestoneError):
        services.open_dispute(milestone, user=customer, checklist_item=item, evidence=["x"])


def test_open_dispute_without_evidence_is_forbidden(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    item = add_checklist_item_with_evidence(milestone)
    with pytest.raises(services.EvidenceRequiredError):
        services.open_dispute(milestone, user=customer, checklist_item=item, evidence=[])


def test_open_dispute_sets_contract_cap_and_response_window(dispute):
    assert dispute.kind == Dispute.Kind.MILESTONE
    assert dispute.contract_id == dispute.milestone.contract_id
    assert dispute.cap_deadline_at is not None
    # 30 суток минус доли секунды -> 29 полных дней (ADR-020).
    assert services.days_to_cap(dispute) == 29
    window = dispute.windows.get()
    assert window.kind == DisputeWindow.Kind.DISPUTE_RESPONSE
    assert window.contested is None and window.closed_at is None


# --- Раунды исправления (tech-spec.md §8.8) --------------------------------


def test_request_fix_first_round_moves_to_awaiting_fix(dispute, customer):
    fix_request = services.request_fix(dispute, user=customer, comment="переложить плитку")
    dispute.refresh_from_db()
    assert fix_request.round == 1
    assert dispute.fix_rounds_used == 1
    assert dispute.status == _STATUS.AWAITING_FIX


def test_resubmit_fix_returns_dispute_to_open(dispute, customer, contractor):
    fix_request = services.request_fix(dispute, user=customer)
    services.resubmit_fix(fix_request, user=contractor, comment="исправил")
    dispute.refresh_from_db()
    assert dispute.status == _STATUS.OPEN
    fix_request.refresh_from_db()
    assert fix_request.resubmitted_at is not None


def test_two_fix_rounds_then_third_is_rejected(dispute, customer, contractor):
    for _round in (1, 2):
        fix_request = services.request_fix(dispute, user=customer)
        services.resubmit_fix(fix_request, user=contractor)
        dispute.refresh_from_db()
    assert dispute.fix_rounds_used == 2
    with pytest.raises(services.FixRoundsExhaustedError):
        services.request_fix(dispute, user=customer)


def test_request_fix_by_contractor_is_forbidden(dispute, contractor):
    with pytest.raises(services.WrongDisputeSideError):
        services.request_fix(dispute, user=contractor)


def test_resubmit_fix_by_customer_is_forbidden(dispute, customer):
    fix_request = services.request_fix(dispute, user=customer)
    with pytest.raises(services.WrongDisputeSideError):
        services.resubmit_fix(fix_request, user=customer)


def test_request_fix_while_awaiting_fix_is_forbidden(dispute, customer):
    services.request_fix(dispute, user=customer)
    dispute.refresh_from_db()
    with pytest.raises(services.InvalidDisputeTransitionError):
        services.request_fix(dispute, user=customer)


def test_resubmit_fix_twice_is_forbidden(dispute, customer, contractor):
    fix_request = services.request_fix(dispute, user=customer)
    services.resubmit_fix(fix_request, user=contractor)
    dispute.refresh_from_db()
    with pytest.raises(services.FixRequestAlreadyResubmittedError):
        services.resubmit_fix(fix_request, user=contractor)


def test_fix_rounds_on_warranty_dispute_are_not_applicable(customer, contractor):
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    warranty_dispute = services.open_warranty_dispute(
        contract, user=customer, description="течёт", evidence=["photo.jpg"]
    )
    with pytest.raises(services.DiscountNotApplicableError):
        services.request_fix(warranty_dispute, user=customer)


# --- Ответ второй стороны и окна оспаривания (ADR-019) --------------------


def test_respond_closes_response_window_as_contested(dispute, contractor):
    services.respond_to_dispute(dispute, user=contractor, comment="дефект спорный", evidence=[])
    window = dispute.windows.get()
    assert window.contested is True
    assert window.contested_by_id == contractor.id
    assert window.closed_at is not None


def test_respond_stores_reply_with_author_text_and_evidence(dispute, contractor):
    """Хвост волны 4: реплика — строка `DisputeReply`, а не только payload
    события (карточка спора отдаёт её в `replies`)."""
    services.respond_to_dispute(
        dispute, user=contractor, comment="дефект спорный", evidence=["photo-ok.jpg"]
    )
    reply = dispute.replies.get()
    assert reply.author_id == contractor.id
    assert reply.comment == "дефект спорный"
    assert reply.evidence == ["photo-ok.jpg"]
    assert reply.created_at is not None
    event = OutboxEvent.objects.get(topic="dispute.responded")
    assert event.payload["reply_id"] == str(reply.id)


def test_respond_by_opener_is_forbidden(dispute, customer):
    with pytest.raises(services.NotDisputeCounterpartyError):
        services.respond_to_dispute(dispute, user=customer, comment="сам себе", evidence=[])


def test_respond_by_outsider_is_forbidden(dispute):
    outsider = make_user("d009")
    with pytest.raises(contracts_services.NotAPartyError):
        services.respond_to_dispute(dispute, user=outsider, comment="я мимо", evidence=[])


def test_expire_window_records_uncontested_fact_without_resolving_dispute(dispute):
    window = dispute.windows.get()
    services.expire_window(window)
    window.refresh_from_db()
    dispute.refresh_from_db()
    assert window.contested is False
    # ADR-019: «факт зафиксирован» — но это не санкция: спор остаётся открытым.
    assert dispute.status == _STATUS.OPEN


def test_expire_window_twice_is_forbidden(dispute):
    window = dispute.windows.get()
    services.expire_window(window)
    window.refresh_from_db()
    with pytest.raises(services.WindowAlreadyClosedError):
        services.expire_window(window)


def test_contest_window_by_outsider_is_forbidden(dispute):
    outsider = make_user("d010")
    window = dispute.windows.get()
    with pytest.raises(contracts_services.NotAPartyError):
        services.contest_window(window, user=outsider)


# --- Закрытие спора --------------------------------------------------------


def test_resolve_dispute_sets_outcome_and_closes_windows(dispute, contractor):
    services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    dispute.refresh_from_db()
    assert dispute.status == _STATUS.RESOLVED
    assert dispute.outcome == Dispute.Outcome.RESOLVED
    assert dispute.resolved_at is not None
    window = dispute.windows.get()
    # Окно снято досрочно: исхода у него нет, но оно закрыто.
    assert window.closed_at is not None and window.contested is None


def test_resolve_dispute_twice_is_forbidden(dispute, contractor):
    services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    dispute.refresh_from_db()
    with pytest.raises(services.DisputeAlreadyResolvedError):
        services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")


def test_resolve_dispute_unknown_resolution_is_rejected(dispute, contractor):
    with pytest.raises(ValueError, match="неизвестный исход"):
        services.resolve_dispute(dispute, user=contractor, resolution_type="ну_как_то_так")


def test_resolve_from_awaiting_fix_is_allowed(dispute, customer, contractor):
    services.request_fix(dispute, user=customer)
    dispute.refresh_from_db()
    services.resolve_dispute(dispute, user=contractor, resolution_type="withdrawn")
    dispute.refresh_from_db()
    assert dispute.status == _STATUS.RESOLVED


def test_escalated_to_court_outcome(dispute, customer):
    services.resolve_dispute(dispute, user=customer, resolution_type="escalated_to_court")
    dispute.refresh_from_db()
    assert dispute.outcome == Dispute.Outcome.ESCALATED_TO_COURT


def test_resolve_warranty_declined_by_customer_is_forbidden(customer, contractor):
    """Отказать по претензии может только исполнитель — сторона, к которой
    она предъявлена; заказчик через `/resolve` этот исход выбрать не может."""
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    dispute = services.open_warranty_dispute(
        contract, user=customer, description="дефект", evidence=["photo.jpg"]
    )
    with pytest.raises(services.WrongDisputeSideError):
        services.resolve_dispute(dispute, user=customer, resolution_type="warranty_declined")
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN


def test_resolve_warranty_satisfied_by_contractor_is_forbidden(customer, contractor):
    """ADR-133: подтвердить устранение может только заказчик — исполнитель
    не «удовлетворяет» претензию к себе (симметрично `warranty_declined`)."""
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    dispute = services.open_warranty_dispute(
        contract, user=customer, description="дефект", evidence=["photo.jpg"]
    )
    with pytest.raises(services.WrongDisputeSideError):
        services.resolve_dispute(dispute, user=contractor, resolution_type="warranty_satisfied")
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN


def test_resolve_warranty_satisfied_by_customer_is_allowed(customer, contractor):
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    dispute = services.open_warranty_dispute(
        contract, user=customer, description="дефект", evidence=["photo.jpg"]
    )
    services.resolve_dispute(dispute, user=customer, resolution_type="warranty_satisfied")
    dispute.refresh_from_db()
    assert dispute.resolution_type == "warranty_satisfied"


def test_resolve_warranty_satisfied_by_system_skips_role_guard(customer, contractor):
    """`user=None` — системный исход (авто-подтверждение по свипу, ADR-133)."""
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    dispute = services.open_warranty_dispute(
        contract, user=customer, description="дефект", evidence=["photo.jpg"]
    )
    services.resolve_dispute(dispute, user=None, resolution_type="warranty_satisfied")
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.RESOLVED


def test_resolve_warranty_declined_by_contractor_is_allowed(customer, contractor):
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    dispute = services.open_warranty_dispute(
        contract, user=customer, description="дефект", evidence=["photo.jpg"]
    )
    services.resolve_dispute(dispute, user=contractor, resolution_type="warranty_declined")
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.resolution_type == "warranty_declined"


def test_request_fix_on_resolved_dispute_is_forbidden(dispute, customer, contractor):
    services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    dispute.refresh_from_db()
    with pytest.raises(services.DisputeAlreadyResolvedError):
        services.request_fix(dispute, user=customer)


def test_respond_on_resolved_dispute_is_forbidden(dispute, contractor):
    services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    dispute.refresh_from_db()
    with pytest.raises(services.DisputeAlreadyResolvedError):
        services.respond_to_dispute(dispute, user=contractor, comment="", evidence=[])
