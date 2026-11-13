"""apps.warranty — гарантийный цикл (ADR-029/030, ADR-131):
`contract.completed` -> `contract.warranty_started` -> претензия в течение
срока -> по истечении `contract.closed` свипом."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.contracts import services as contracts_services
from apps.contracts.models import Contract
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from apps.disputes import services as disputes_services
from apps.disputes.models import Dispute
from apps.disputes.tests._helpers import make_warranty_contract
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.notifications import tasks as notifications_tasks
from apps.notifications.models import Notification, ReminderPointConfig, ReminderSchedule
from apps.warranty import services
from apps.warranty.models import WarrantyClaim, WarrantyFix
from common import relay
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("w001")


@pytest.fixture
def contractor():
    return make_user("w002")


@pytest.fixture
def warranty_contract(customer, contractor):
    return make_warranty_contract(customer=customer, contractor=contractor)


def _client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_completed_contract_enters_warranty_with_deadline(warranty_contract):
    contract, _milestone = warranty_contract
    assert contract.execution_status == Contract.ExecutionStatus.WARRANTY
    assert DomainDeadline.objects.filter(
        kind="contract_warranty", subject_type="contract", subject_id=contract.id
    ).exists()


def test_submit_claim_opens_warranty_dispute(warranty_contract, customer):
    contract, _milestone = warranty_contract
    claim = services.submit_warranty_claim(
        contract, user=customer, description="плитка отошла", evidence=["photo.jpg"]
    )
    assert claim.status == WarrantyClaim.Status.SUBMITTED
    dispute = Dispute.objects.get(pk=claim.dispute_id)
    assert dispute.kind == Dispute.Kind.WARRANTY
    assert dispute.milestone_id is None
    assert dispute.checklist_item_id is None
    assert dispute.contract_id == contract.id
    # Тот же диалоговый контур: потолок 30 дней и окно ответа.
    assert dispute.cap_deadline_at is not None
    assert dispute.windows.count() == 1


def test_claim_by_contractor_is_forbidden(warranty_contract, contractor):
    contract, _milestone = warranty_contract
    with pytest.raises(services.NotCustomerError):
        services.submit_warranty_claim(
            contract, user=contractor, description="сам себе", evidence=["x"]
        )


def test_claim_without_evidence_is_forbidden(warranty_contract, customer):
    contract, _milestone = warranty_contract
    with pytest.raises(disputes_services.EvidenceRequiredError):
        services.submit_warranty_claim(
            contract, user=customer, description="на словах", evidence=[]
        )


def test_claim_before_completion_is_forbidden(customer, contractor):
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    with pytest.raises(disputes_services.WarrantyPeriodNotActiveError):
        services.submit_warranty_claim(contract, user=customer, description="рано", evidence=["x"])


def test_warranty_period_expiry_closes_contract_and_blocks_new_claims(warranty_contract, customer):
    contract, _milestone = warranty_contract
    deadline = DomainDeadline.objects.get(
        kind="contract_warranty", subject_type="contract", subject_id=contract.id
    )
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    relay.deliver_due_events()

    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.CLOSED
    with pytest.raises(disputes_services.WarrantyPeriodNotActiveError):
        services.submit_warranty_claim(
            contract, user=customer, description="поздно", evidence=["x"]
        )


def test_dispute_resolution_closes_claim(warranty_contract, customer, contractor):
    """Общий `/disputes/{id}/resolve` заказчиком: заявку закрывает подписчик
    `handle_dispute_resolved` (ADR-133: `warranty_satisfied` — только заказчик)."""
    contract, _milestone = warranty_contract
    claim = services.submit_warranty_claim(
        contract, user=customer, description="плитка отошла", evidence=["photo.jpg"]
    )
    dispute = Dispute.objects.get(pk=claim.dispute_id)
    disputes_services.resolve_dispute(dispute, user=customer, resolution_type="warranty_satisfied")
    relay.deliver_due_events()
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.RESOLVED
    assert claim.resolution_type == "warranty_satisfied"
    assert claim.resolved_at is not None


def test_warranty_dispute_does_not_touch_reputation(warranty_contract, customer, contractor):
    """ADR-030: гарантийные обращения — ОТДЕЛЬНАЯ метрика; счётчики споров
    репутационной карточки их не считают, хотя топики те же."""
    from apps.reputation.models import DealFact

    contract, _milestone = warranty_contract
    relay.deliver_due_events()
    before = DealFact.objects.filter(contract_id=contract.id).first()
    disputes_before = before.disputes_opened if before else 0

    claim = services.submit_warranty_claim(
        contract, user=customer, description="дефект", evidence=["photo.jpg"]
    )
    relay.deliver_due_events()
    services.satisfy_warranty_claim(claim, user=customer)
    relay.deliver_due_events()

    after = DealFact.objects.get(contract_id=contract.id)
    assert after.disputes_opened == disputes_before
    assert after.disputes_resolved == 0
    assert after.dispute_resolutions == []


def test_resolve_claim_twice_is_forbidden(warranty_contract, customer):
    contract, _milestone = warranty_contract
    claim = services.submit_warranty_claim(
        contract, user=customer, description="дефект", evidence=["photo.jpg"]
    )
    services.resolve_warranty_claim(claim, resolution_type="warranty_declined")
    with pytest.raises(services.ClaimAlreadyResolvedError):
        services.resolve_warranty_claim(claim, resolution_type="warranty_declined")


def test_warranty_claim_api_roundtrip(warranty_contract, customer, contractor):
    contract, _milestone = warranty_contract
    resp = _client(customer).post(
        f"/v1/contracts/{contract.id}/warranty-claims",
        {"description": "плитка отошла", "evidence": ["photo.jpg"]},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["status"] == "submitted"
    assert body["dispute_id"]

    resp = _client(contractor).get(f"/v1/contracts/{contract.id}/warranty-claims")
    assert resp.status_code == 200
    assert len(resp.json()) == 1

    resp = _client(customer).get("/v1/warranty-claims")
    assert resp.status_code == 200
    assert resp.json()[0]["id"] == body["id"]


def test_warranty_claim_api_by_contractor_is_403(warranty_contract, contractor):
    contract, _milestone = warranty_contract
    resp = _client(contractor).post(
        f"/v1/contracts/{contract.id}/warranty-claims",
        {"description": "сам себе", "evidence": ["x"]},
        format="json",
    )
    assert resp.status_code == 403


def test_warranty_claim_api_for_outsider_is_403(warranty_contract):
    contract, _milestone = warranty_contract
    outsider = make_user("w009")
    resp = _client(outsider).get(f"/v1/contracts/{contract.id}/warranty-claims")
    assert resp.status_code == 403


# --- Отказ по претензии (`POST /warranty-claims/{id}/decline`) --------------


@pytest.fixture
def claim(warranty_contract, customer):
    contract, _milestone = warranty_contract
    return services.submit_warranty_claim(
        contract, user=customer, description="плитка отошла", evidence=["photo.jpg"]
    )


def test_decline_claim_by_contractor_resolves_claim_and_dispute(claim, contractor):
    """Переход submitted -> resolved(warranty_declined) синхронно со спором."""
    services.decline_warranty_claim(claim, user=contractor, comment="монтаж по ТЗ")
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.RESOLVED
    assert claim.resolution_type == "warranty_declined"
    assert claim.resolved_at is not None
    dispute = Dispute.objects.get(pk=claim.dispute_id)
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.resolution_type == "warranty_declined"
    assert dispute.outcome == Dispute.Outcome.RESOLVED
    event = OutboxEvent.objects.get(topic="warranty.claim_declined")
    assert event.payload["comment"] == "монтаж по ТЗ"
    assert event.payload["affects_reputation"] is False
    assert event.actor == {"user_id": str(contractor.id)}
    # Один момент — одно событие приложения: `claim_resolved` рядом не публикуется.
    assert not OutboxEvent.objects.filter(topic="warranty.claim_resolved").exists()


def test_decline_then_dispute_resolved_subscriber_is_noop(claim, contractor):
    """`dispute.resolved` доезжает до `handlers.handle_dispute_resolved` уже
    на закрытой заявке — NOOP, а не ClaimAlreadyResolvedError в очереди."""
    services.decline_warranty_claim(claim, user=contractor)
    relay.deliver_due_events()
    relay.deliver_due_events()
    claim.refresh_from_db()
    assert claim.resolution_type == "warranty_declined"
    assert OutboxEvent.objects.filter(topic="warranty.claim_declined").count() == 1
    assert not OutboxEvent.objects.filter(topic="warranty.claim_resolved").exists()


def test_decline_claim_by_customer_is_forbidden(claim, customer):
    with pytest.raises(services.NotContractorError):
        services.decline_warranty_claim(claim, user=customer)
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.SUBMITTED


def test_decline_claim_by_outsider_is_forbidden(claim):
    with pytest.raises(contracts_services.NotAPartyError):
        services.decline_warranty_claim(claim, user=make_user("w010"))


def test_decline_resolved_claim_is_forbidden(claim, contractor):
    services.decline_warranty_claim(claim, user=contractor)
    claim.refresh_from_db()
    with pytest.raises(services.ClaimAlreadyResolvedError):
        services.decline_warranty_claim(claim, user=contractor)


def test_decline_when_dispute_already_resolved_is_forbidden(claim, customer, contractor):
    """Спор закрыт иначе (например, `warranty_satisfied` заказчиком через
    `/resolve`), а подписчик ещё не доехал до заявки — отказ невозможен:
    исход уже есть."""
    dispute = Dispute.objects.get(pk=claim.dispute_id)
    disputes_services.resolve_dispute(dispute, user=customer, resolution_type="warranty_satisfied")
    with pytest.raises(disputes_services.DisputeAlreadyResolvedError):
        services.decline_warranty_claim(claim, user=contractor)
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.SUBMITTED


def test_decline_claim_without_dispute_is_forbidden(claim, contractor):
    claim.dispute_id = None
    claim.save(update_fields=["dispute_id"])
    with pytest.raises(services.ClaimDisputeMissingError):
        services.decline_warranty_claim(claim, user=contractor)


def test_decline_claim_api_roundtrip(claim, contractor):
    resp = _client(contractor).post(
        f"/v1/warranty-claims/{claim.id}/decline", {"comment": "монтаж по ТЗ"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["status"] == "resolved"
    assert body["resolution_type"] == "warranty_declined"
    assert body["resolved_at"]

    resp = _client(contractor).post(f"/v1/warranty-claims/{claim.id}/decline", {}, format="json")
    assert resp.status_code == 409
    assert resp.json()["code"] == "warranty_claim_already_resolved"


def test_decline_claim_api_by_customer_is_403(claim, customer):
    resp = _client(customer).post(f"/v1/warranty-claims/{claim.id}/decline", {}, format="json")
    assert resp.status_code == 403
    assert resp.json()["code"] == "wrong_dispute_side"


def test_decline_claim_api_by_outsider_is_403(claim):
    resp = _client(make_user("w011")).post(
        f"/v1/warranty-claims/{claim.id}/decline", {}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "permission_denied"


# --- ADR-133: устранил -> подтвердил / не устранено / авто --------------------


def _acceptance_deadline(claim) -> DomainDeadline | None:
    claim.refresh_from_db()
    if claim.acceptance_deadline_id is None:
        return None
    return DomainDeadline.objects.get(pk=claim.acceptance_deadline_id)


def _deliver(n: int = 2) -> None:
    for _ in range(n):
        relay.deliver_due_events()


@pytest.fixture
def awaiting_claim(claim, contractor):
    services.submit_warranty_fix(
        claim, user=contractor, comment="переклеили", evidence=["after.jpg"]
    )
    claim.refresh_from_db()
    return claim


def test_warranty_acceptance_window_equals_milestone_acceptance():
    """Решение владельца: «в течение времени окна приёмки» — сид берёт
    длительность из `milestone_acceptance` (deadlines/0007)."""
    assert (
        DeadlineKindConfig.objects.get(kind="warranty_claim_acceptance").duration
        == DeadlineKindConfig.objects.get(kind="milestone_acceptance").duration
    )


# submit_warranty_fix: submitted -> awaiting_confirmation


def test_fix_submitted_moves_to_awaiting_confirmation_and_creates_deadline(claim, contractor):
    fix = services.submit_warranty_fix(
        claim, user=contractor, comment="переклеили", evidence=["after.jpg"]
    )
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.AWAITING_CONFIRMATION
    assert claim.fix_submitted_at is not None
    assert fix.round == 1 and fix.comment == "переклеили" and fix.evidence == ["after.jpg"]
    deadline = _acceptance_deadline(claim)
    assert deadline is not None
    assert deadline.kind == "warranty_claim_acceptance"
    assert deadline.subject_type == "warranty_claim" and deadline.subject_id == claim.id
    # ADR-057: тикает с размещения уведомления в ЛК заказчика — оно
    # размещается тут же, прямым вызовом (доп. 26.08), поэтому якорь уже есть.
    assert deadline.starts_from == "cabinet_placement" and deadline.anchor_at is not None
    assert deadline.deadline_at is not None
    event = OutboxEvent.objects.get(topic="warranty.fix_submitted")
    assert event.payload["round"] == 1 and event.payload["rounds_left"] == 2
    assert event.actor == {"user_id": str(contractor.id)}
    # Спор остаётся открытым — диалог не прерывается.
    assert Dispute.objects.get(pk=claim.dispute_id).status == Dispute.Status.OPEN


def test_fix_submitted_deadline_is_anchored_by_cabinet_placement(awaiting_claim, customer):
    """Якорь — `placed_in_cabinet_at` уведомления ЗАКАЗЧИКУ (не исполнителю)."""
    deadline = _acceptance_deadline(awaiting_claim)
    assert deadline is not None and deadline.anchor_at is not None
    anchoring = Notification.objects.get(related_deadline=deadline)
    assert anchoring.recipient_id == customer.id
    assert anchoring.template == "warranty.fix_submitted"
    assert anchoring.placed_in_cabinet_at == deadline.anchor_at
    assert anchoring.contract_id == awaiting_claim.contract_id
    assert (
        deadline.deadline_at
        == deadline.anchor_at
        + DeadlineKindConfig.objects.get(kind="warranty_claim_acceptance").duration
    )
    assert services.acceptance_deadline_at(awaiting_claim) == deadline.deadline_at


def test_fix_submitted_by_customer_is_forbidden(claim, customer):
    with pytest.raises(services.NotContractorError):
        services.submit_warranty_fix(claim, user=customer)
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.SUBMITTED


def test_fix_submitted_by_outsider_is_forbidden(claim):
    with pytest.raises(contracts_services.NotAPartyError):
        services.submit_warranty_fix(claim, user=make_user("w020"))


def test_fix_submitted_twice_is_forbidden(awaiting_claim, contractor):
    with pytest.raises(services.ClaimAlreadyAwaitingConfirmationError):
        services.submit_warranty_fix(awaiting_claim, user=contractor)
    assert WarrantyFix.objects.filter(claim=awaiting_claim).count() == 1


def test_fix_submitted_on_resolved_claim_is_forbidden(claim, contractor):
    services.decline_warranty_claim(claim, user=contractor)
    claim.refresh_from_db()
    with pytest.raises(services.ClaimAlreadyResolvedError):
        services.submit_warranty_fix(claim, user=contractor)


# satisfy_warranty_claim: -> resolved(warranty_satisfied)


def test_satisfy_from_awaiting_confirmation_closes_claim_and_dispute(awaiting_claim, customer):
    services.satisfy_warranty_claim(awaiting_claim, user=customer, comment="всё ок")
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.RESOLVED
    assert awaiting_claim.resolution_type == "warranty_satisfied"
    assert awaiting_claim.resolved_at is not None
    assert awaiting_claim.acceptance_deadline_id is None
    dispute = Dispute.objects.get(pk=awaiting_claim.dispute_id)
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.resolution_type == "warranty_satisfied"
    event = OutboxEvent.objects.get(topic="warranty.claim_satisfied")
    assert event.payload["comment"] == "всё ок" and event.payload["auto"] is False
    assert event.payload["affects_reputation"] is False
    assert event.actor == {"user_id": str(customer.id)}
    assert not OutboxEvent.objects.filter(topic="warranty.claim_resolved").exists()


def test_satisfy_pauses_acceptance_deadline(awaiting_claim, customer):
    deadline_before = _acceptance_deadline(awaiting_claim)
    services.satisfy_warranty_claim(awaiting_claim, user=customer)
    deadline_before.refresh_from_db()
    assert deadline_before.paused is True and deadline_before.fired_at is None


def test_satisfy_from_submitted_without_fix_is_allowed(claim, customer):
    """Симметрично отказу: устранили на месте, формального «устранил» не было."""
    services.satisfy_warranty_claim(claim, user=customer)
    claim.refresh_from_db()
    assert claim.resolution_type == "warranty_satisfied"


def test_satisfy_then_dispute_resolved_subscriber_is_noop(awaiting_claim, customer):
    services.satisfy_warranty_claim(awaiting_claim, user=customer)
    _deliver()
    assert OutboxEvent.objects.filter(topic="warranty.claim_satisfied").count() == 1
    assert not OutboxEvent.objects.filter(topic="warranty.claim_resolved").exists()


def test_satisfy_by_contractor_is_forbidden(awaiting_claim, contractor):
    with pytest.raises(services.NotCustomerError):
        services.satisfy_warranty_claim(awaiting_claim, user=contractor)
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.AWAITING_CONFIRMATION


def test_satisfy_by_outsider_is_forbidden(awaiting_claim):
    with pytest.raises(contracts_services.NotAPartyError):
        services.satisfy_warranty_claim(awaiting_claim, user=make_user("w021"))


def test_satisfy_twice_is_forbidden(awaiting_claim, customer):
    services.satisfy_warranty_claim(awaiting_claim, user=customer)
    awaiting_claim.refresh_from_db()
    with pytest.raises(services.ClaimAlreadyResolvedError):
        services.satisfy_warranty_claim(awaiting_claim, user=customer)


def test_satisfy_when_dispute_already_resolved_is_forbidden(awaiting_claim, customer, contractor):
    dispute = Dispute.objects.get(pk=awaiting_claim.dispute_id)
    disputes_services.resolve_dispute(dispute, user=contractor, resolution_type="warranty_declined")
    with pytest.raises(disputes_services.DisputeAlreadyResolvedError):
        services.satisfy_warranty_claim(awaiting_claim, user=customer)


def test_satisfy_without_dispute_is_forbidden(awaiting_claim, customer):
    awaiting_claim.dispute_id = None
    awaiting_claim.save(update_fields=["dispute_id"])
    with pytest.raises(services.ClaimDisputeMissingError):
        services.satisfy_warranty_claim(awaiting_claim, user=customer)


def test_resolve_dispute_warranty_satisfied_by_contractor_is_forbidden(claim, contractor):
    """Гард в `disputes.resolve_dispute`: общий `/resolve` не даёт исполнителю
    «удовлетворить» претензию к себе (это и была дыра)."""
    dispute = Dispute.objects.get(pk=claim.dispute_id)
    with pytest.raises(disputes_services.WrongDisputeSideError):
        disputes_services.resolve_dispute(
            dispute, user=contractor, resolution_type="warranty_satisfied"
        )
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN


# contest_warranty_claim: awaiting_confirmation -> submitted


def test_contest_returns_claim_to_contractor_and_counts_round(awaiting_claim, customer):
    services.contest_warranty_claim(
        awaiting_claim, user=customer, comment="снова отошла", evidence=["again.jpg"]
    )
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.SUBMITTED
    assert awaiting_claim.fix_rounds_used == 1 and awaiting_claim.fix_rounds_left == 1
    assert awaiting_claim.fix_submitted_at is None
    assert awaiting_claim.acceptance_deadline_id is None
    fix = WarrantyFix.objects.get(claim=awaiting_claim, round=1)
    assert fix.contested_by_id == customer.id and fix.contested_at is not None
    assert fix.contest_comment == "снова отошла" and fix.contest_evidence == ["again.jpg"]
    event = OutboxEvent.objects.get(topic="warranty.claim_contested")
    assert event.payload["round"] == 1 and event.payload["rounds_left"] == 1
    assert Dispute.objects.get(pk=awaiting_claim.dispute_id).status == Dispute.Status.OPEN


def test_contest_pauses_acceptance_deadline(awaiting_claim, customer):
    deadline = _acceptance_deadline(awaiting_claim)
    services.contest_warranty_claim(awaiting_claim, user=customer, comment="нет")
    deadline.refresh_from_db()
    assert deadline.paused is True


def test_contest_then_new_fix_round_opens_new_window(awaiting_claim, customer, contractor):
    first_deadline = _acceptance_deadline(awaiting_claim)
    services.contest_warranty_claim(awaiting_claim, user=customer, comment="нет")
    fix = services.submit_warranty_fix(awaiting_claim, user=contractor, comment="ещё раз")
    awaiting_claim.refresh_from_db()
    assert fix.round == 2
    assert awaiting_claim.status == WarrantyClaim.Status.AWAITING_CONFIRMATION
    assert awaiting_claim.acceptance_deadline_id not in (None, first_deadline.id)


def test_contest_third_time_is_fix_rounds_exhausted(claim, customer, contractor):
    for _ in range(2):
        services.submit_warranty_fix(claim, user=contractor)
        claim.refresh_from_db()
        services.contest_warranty_claim(claim, user=customer, comment="нет")
        claim.refresh_from_db()
    assert claim.fix_rounds_used == 2 and claim.fix_rounds_left == 0
    services.submit_warranty_fix(claim, user=contractor)
    claim.refresh_from_db()
    with pytest.raises(services.FixRoundsExhaustedError):
        services.contest_warranty_claim(claim, user=customer, comment="нет")
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.AWAITING_CONFIRMATION
    assert claim.fix_rounds_used == 2
    # Дальше — подтверждение или отказ исполнителя; оба ещё доступны.
    services.satisfy_warranty_claim(claim, user=customer)


def test_contest_without_fix_submitted_is_forbidden(claim, customer):
    with pytest.raises(services.ClaimNotAwaitingConfirmationError):
        services.contest_warranty_claim(claim, user=customer, comment="нет")


def test_contest_by_contractor_is_forbidden(awaiting_claim, contractor):
    with pytest.raises(services.NotCustomerError):
        services.contest_warranty_claim(awaiting_claim, user=contractor, comment="нет")


def test_contest_by_outsider_is_forbidden(awaiting_claim):
    with pytest.raises(contracts_services.NotAPartyError):
        services.contest_warranty_claim(awaiting_claim, user=make_user("w022"), comment="нет")


def test_contest_on_resolved_claim_is_forbidden(awaiting_claim, customer):
    services.satisfy_warranty_claim(awaiting_claim, user=customer)
    awaiting_claim.refresh_from_db()
    with pytest.raises(services.ClaimAlreadyResolvedError):
        services.contest_warranty_claim(awaiting_claim, user=customer, comment="нет")


def test_decline_from_awaiting_confirmation_pauses_window(awaiting_claim, contractor):
    deadline = _acceptance_deadline(awaiting_claim)
    services.decline_warranty_claim(awaiting_claim, user=contractor)
    deadline.refresh_from_db()
    awaiting_claim.refresh_from_db()
    assert deadline.paused is True
    assert awaiting_claim.acceptance_deadline_id is None
    assert awaiting_claim.resolution_type == "warranty_declined"


# Свип: автоподтверждение


def _expire_window(claim) -> DomainDeadline:
    _deliver()  # размещение уведомления якорит дедлайн
    deadline = _acceptance_deadline(claim)
    assert deadline is not None and deadline.deadline_at is not None
    deadline.deadline_at = timezone.now() - timedelta(minutes=1)
    deadline.save(update_fields=["deadline_at"])
    return deadline


def test_sweep_auto_satisfies_claim_when_customer_is_silent(awaiting_claim, customer, contractor):
    _expire_window(awaiting_claim)
    assert deadlines_tasks.sweep_domain_deadlines() == 1
    _deliver()
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.RESOLVED
    assert awaiting_claim.resolution_type == "warranty_satisfied"
    dispute = Dispute.objects.get(pk=awaiting_claim.dispute_id)
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.resolution_type == "warranty_satisfied"
    event = OutboxEvent.objects.get(topic="warranty.claim_auto_satisfied")
    assert event.payload["auto"] is True and event.actor == {}
    assert not OutboxEvent.objects.filter(topic="warranty.claim_satisfied").exists()
    assert not OutboxEvent.objects.filter(topic="warranty.claim_resolved").exists()


def test_sweep_does_not_fire_after_contest(awaiting_claim, customer):
    _deliver()
    services.contest_warranty_claim(awaiting_claim, user=customer, comment="нет")
    deadline = DomainDeadline.objects.get(
        kind="warranty_claim_acceptance", subject_id=awaiting_claim.id
    )
    deadline.deadline_at = timezone.now() - timedelta(minutes=1)
    deadline.save(update_fields=["deadline_at"])
    assert deadlines_tasks.sweep_domain_deadlines() == 0
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.SUBMITTED


def test_stale_deadline_event_does_not_close_new_round(awaiting_claim, customer, contractor):
    """Повторная доставка срабатывания СТАРОГО окна (ADR-064) на претензию,
    где уже идёт новый раунд, — NOOP: подписчик сверяет deadline_id."""
    from apps.warranty import handlers

    old_deadline = _expire_window(awaiting_claim)
    services.contest_warranty_claim(awaiting_claim, user=customer, comment="нет")
    services.submit_warranty_fix(awaiting_claim, user=contractor)
    stale = OutboxEvent(
        topic="domain_deadline.fired",
        subject={"type": "warranty_claim", "id": str(awaiting_claim.id)},
        payload={"deadline_id": str(old_deadline.id), "kind": "warranty_claim_acceptance"},
        actor={},
    )
    handlers.handle_deadline_fired(stale)
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.AWAITING_CONFIRMATION


def test_sweep_on_already_resolved_dispute_is_noop(awaiting_claim, contractor):
    """Потолок/отказ закрыл спор раньше — авто-исход не перебивает его."""
    from apps.warranty import handlers

    deadline = _expire_window(awaiting_claim)
    dispute = Dispute.objects.get(pk=awaiting_claim.dispute_id)
    # Спор закрыт напрямую через `/resolve`; подписчик `handle_dispute_resolved`
    # до заявки ещё не доехал — она формально всё ещё ждёт подтверждения.
    disputes_services.resolve_dispute(dispute, user=contractor, resolution_type="warranty_declined")
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.AWAITING_CONFIRMATION
    handlers.handle_deadline_fired(
        OutboxEvent(
            topic="domain_deadline.fired",
            subject={"type": "warranty_claim", "id": str(awaiting_claim.id)},
            payload={"deadline_id": str(deadline.id), "kind": "warranty_claim_acceptance"},
            actor={},
        )
    )
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.status == WarrantyClaim.Status.AWAITING_CONFIRMATION
    assert not OutboxEvent.objects.filter(topic="warranty.claim_auto_satisfied").exists()
    # Доехавший подписчик закрывает заявку исходом спора, не авто-исходом.
    _deliver()
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.resolution_type == "warranty_declined"
    assert awaiting_claim.acceptance_deadline_id is None


# Уведомления (ADR-126)


def _templates(user) -> set[str]:
    return set(Notification.objects.filter(recipient=user).values_list("template", flat=True))


def test_fix_cycle_notifies_only_the_other_side(claim, customer, contractor):
    """ADR-178: заказчику — прямым вызовом (получатель уже не актор); актору
    (исполнителю, submit_warranty_fix) собственную копию реестр адресата
    больше не размещает."""
    _deliver()
    Notification.objects.all().delete()
    services.submit_warranty_fix(claim, user=contractor)
    _deliver()
    assert "warranty.fix_submitted" not in _templates(contractor)
    assert (
        Notification.objects.filter(recipient=customer, template="warranty.fix_submitted").count()
        == 1
    )
    claim.refresh_from_db()
    services.contest_warranty_claim(claim, user=customer, comment="нет")
    _deliver()
    assert "warranty.claim_contested" not in _templates(customer)
    assert "warranty.claim_contested" in _templates(contractor)
    claim.refresh_from_db()
    services.submit_warranty_fix(claim, user=contractor)
    claim.refresh_from_db()
    services.satisfy_warranty_claim(claim, user=customer)
    _deliver()
    assert "warranty.claim_satisfied" not in _templates(customer)
    assert "warranty.claim_satisfied" in _templates(contractor)
    for user in (customer, contractor):
        assert "warranty.claim_resolved" not in _templates(user)


def test_auto_satisfied_notifies_both_sides(awaiting_claim, customer, contractor):
    _expire_window(awaiting_claim)
    Notification.objects.all().delete()
    deadlines_tasks.sweep_domain_deadlines()
    _deliver(3)
    for user in (customer, contractor):
        assert "warranty.claim_auto_satisfied" in _templates(user)
        assert "warranty.claim_resolved" not in _templates(user)


# API


def test_fix_cycle_api_roundtrip(claim, customer, contractor):
    resp = _client(contractor).post(
        f"/v1/warranty-claims/{claim.id}/fix-submitted",
        {"comment": "переклеили", "evidence": ["after.jpg"]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["status"] == "awaiting_confirmation"
    assert body["fix_rounds_used"] == 0 and body["fix_rounds_left"] == 2
    assert body["fix_submitted_at"]
    assert body["acceptance_deadline_at"]  # окно заякорено в этой же транзакции
    assert body["fixes"][0]["round"] == 1 and body["fixes"][0]["contested_at"] is None
    _deliver()
    resp = _client(customer).get(f"/v1/contracts/{claim.contract_id}/warranty-claims")
    assert resp.json()[0]["acceptance_deadline_at"]

    resp = _client(contractor).post(
        f"/v1/warranty-claims/{claim.id}/fix-submitted", {}, format="json"
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "warranty_claim_awaiting_confirmation"

    resp = _client(customer).post(
        f"/v1/warranty-claims/{claim.id}/contest", {"comment": "снова отошла"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["status"] == "submitted" and body["fix_rounds_used"] == 1
    assert body["acceptance_deadline_at"] is None
    assert body["fixes"][0]["contest_comment"] == "снова отошла"

    resp = _client(customer).post(
        f"/v1/warranty-claims/{claim.id}/contest", {"comment": "ещё"}, format="json"
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "warranty_claim_not_awaiting_confirmation"

    resp = _client(contractor).post(f"/v1/warranty-claims/{claim.id}/fix-submitted")
    assert resp.status_code == 200, resp.content
    resp = _client(customer).post(
        f"/v1/warranty-claims/{claim.id}/satisfy", {"comment": "ок"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["status"] == "resolved" and body["resolution_type"] == "warranty_satisfied"
    assert body["resolved_at"]

    resp = _client(customer).post(f"/v1/warranty-claims/{claim.id}/satisfy", {}, format="json")
    assert resp.status_code == 409
    assert resp.json()["code"] == "warranty_claim_already_resolved"


def test_contest_api_requires_comment(awaiting_claim, customer):
    resp = _client(customer).post(
        f"/v1/warranty-claims/{awaiting_claim.id}/contest", {}, format="json"
    )
    assert resp.status_code == 400


def test_fix_submitted_api_by_customer_is_403(claim, customer):
    resp = _client(customer).post(f"/v1/warranty-claims/{claim.id}/fix-submitted")
    assert resp.status_code == 403
    assert resp.json()["code"] == "wrong_dispute_side"


def test_satisfy_api_by_contractor_is_403(awaiting_claim, contractor):
    resp = _client(contractor).post(f"/v1/warranty-claims/{awaiting_claim.id}/satisfy")
    assert resp.status_code == 403
    assert resp.json()["code"] == "wrong_dispute_side"


def test_contest_api_by_contractor_is_403(awaiting_claim, contractor):
    resp = _client(contractor).post(
        f"/v1/warranty-claims/{awaiting_claim.id}/contest", {"comment": "нет"}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "wrong_dispute_side"


def test_fix_cycle_api_by_outsider_is_403(awaiting_claim):
    client = _client(make_user("w023"))
    for action, body in (
        ("fix-submitted", {}),
        ("satisfy", {}),
        ("contest", {"comment": "нет"}),
    ):
        resp = client.post(f"/v1/warranty-claims/{awaiting_claim.id}/{action}", body, format="json")
        assert resp.status_code == 403, action
        assert resp.json()["code"] == "permission_denied"


def test_contest_api_fix_rounds_exhausted_is_409(claim, customer, contractor):
    for _ in range(2):
        services.submit_warranty_fix(claim, user=contractor)
        claim.refresh_from_db()
        services.contest_warranty_claim(claim, user=customer, comment="нет")
        claim.refresh_from_db()
    services.submit_warranty_fix(claim, user=contractor)
    resp = _client(customer).post(
        f"/v1/warranty-claims/{claim.id}/contest", {"comment": "нет"}, format="json"
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "fix_rounds_exhausted"


def test_resolve_api_warranty_satisfied_by_contractor_is_403(claim, contractor):
    resp = _client(contractor).post(
        f"/v1/disputes/{claim.dispute_id}/resolve",
        {"resolution_type": "warranty_satisfied"},
        format="json",
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "wrong_dispute_side"


# Серия напоминаний по окну подтверждения (ADR-133, доп. 26.08, в6-8)


def _reminders(claim) -> list[ReminderSchedule]:
    deadline = _acceptance_deadline(claim)
    assert deadline is not None
    return list(ReminderSchedule.objects.filter(deadline=deadline).order_by("point"))


def _make_due(claim) -> None:
    for schedule in _reminders(claim):
        schedule.fire_at = timezone.now() - timedelta(minutes=1)
        schedule.save(update_fields=["fire_at"])


def test_warranty_reminder_points_equal_milestone_acceptance():
    """Сид 0021 берёт точки из `milestone_acceptance` — серия одна."""
    ours = ReminderPointConfig.objects.get(kind="warranty_claim_acceptance")
    assert ours.points == ReminderPointConfig.objects.get(kind="milestone_acceptance").points
    assert ours.template == "warranty_claim_acceptance_reminder"


def test_fix_submitted_schedules_reminder_series_for_customer(awaiting_claim, customer):
    reminders = _reminders(awaiting_claim)
    points = ReminderPointConfig.objects.get(kind="warranty_claim_acceptance").points
    assert [r.point for r in reminders] == sorted(p for p in points if p > 0.0)
    assert {r.recipient_id for r in reminders} == {customer.id}
    assert {r.template for r in reminders} == {"warranty_claim_acceptance_reminder"}
    assert [r.is_final for r in reminders] == [False] * (len(reminders) - 1) + [True]
    assert all(r.fired_at is None for r in reminders)


def test_reminder_series_is_cancelled_by_satisfy(awaiting_claim, customer):
    _make_due(awaiting_claim)
    services.satisfy_warranty_claim(awaiting_claim, user=customer)
    assert notifications_tasks.sweep_reminder_schedules() == 0
    assert not Notification.objects.filter(template="warranty_claim_acceptance_reminder").exists()


def test_reminder_series_is_cancelled_by_contest(awaiting_claim, customer):
    _make_due(awaiting_claim)
    services.contest_warranty_claim(awaiting_claim, user=customer, comment="нет")
    assert notifications_tasks.sweep_reminder_schedules() == 0
    assert not Notification.objects.filter(template="warranty_claim_acceptance_reminder").exists()


def test_reminder_series_is_cancelled_by_contractor_decline(awaiting_claim, contractor):
    _make_due(awaiting_claim)
    services.decline_warranty_claim(awaiting_claim, user=contractor)
    assert notifications_tasks.sweep_reminder_schedules() == 0


def test_new_fix_round_gets_its_own_reminder_series(awaiting_claim, customer, contractor):
    first = _acceptance_deadline(awaiting_claim)
    services.contest_warranty_claim(awaiting_claim, user=customer, comment="нет")
    services.submit_warranty_fix(awaiting_claim, user=contractor)
    second = _acceptance_deadline(awaiting_claim)
    assert first is not None and second is not None and first.id != second.id
    assert ReminderSchedule.objects.filter(deadline=second, recipient=customer).count() == len(
        _reminders(awaiting_claim)
    )
    # Старая серия молчит (её дедлайн на паузе), новая — живёт.
    for schedule in ReminderSchedule.objects.filter(deadline=first):
        schedule.fire_at = timezone.now() - timedelta(minutes=1)
        schedule.save(update_fields=["fire_at"])
    assert notifications_tasks.sweep_reminder_schedules() == 0


@pytest.fixture
def _l10n_packs():
    """Тексты шаблонов-топиков живут в языковых пакетах (l10n/packs), в
    тестовую БД их надо импортировать явно (как в contracts/test_amendment_close)."""
    import json
    from pathlib import Path

    from apps.l10n import services as l10n_services

    packs_dir = Path(__file__).resolve().parents[4] / "l10n" / "packs"
    for code in ("en", "ru"):
        l10n_services.import_pack(
            json.loads((packs_dir / f"{code}.json").read_text(encoding="utf-8"))
        )


def test_reminder_fires_to_customer_with_contract_context(
    _l10n_packs, awaiting_claim, customer, contractor
):
    from apps.notifications import selectors as notification_selectors

    first = _reminders(awaiting_claim)[0]
    first.fire_at = timezone.now() - timedelta(minutes=1)
    first.save(update_fields=["fire_at"])
    assert notifications_tasks.sweep_reminder_schedules() == 1
    notification = Notification.objects.get(template="warranty_claim_acceptance_reminder")
    assert notification.recipient_id == customer.id
    assert notification.legal_significance is True
    assert notification.subject_type == "warranty_claim"
    assert notification.subject_id == awaiting_claim.id
    assert notification.contract_id == awaiting_claim.contract_id
    assert notification.payload.get("contract_title")
    assert not Notification.objects.filter(
        recipient=contractor, template="warranty_claim_acceptance_reminder"
    ).exists()
    ru = notification_selectors.render_body("warranty_claim_acceptance_reminder", locale="ru")
    assert "гарантийной претензии" in ru and "{contract_title}" in ru
    assert "автоматически" in ru
    assert notification_selectors.render_subject("warranty_claim_acceptance_reminder", locale="ru")
    en = notification_selectors.render_body("warranty_claim_acceptance_reminder", locale="en")
    assert "warranty claim" in en and "{contract_title}" in en
    # Лента: тип «дедлайн», группа «Сроки» — как у напоминания о приёмке этапа.
    assert notification_selectors.channel_group_for_template(
        "warranty_claim_acceptance_reminder"
    ) == notification_selectors.channel_group_for_template("milestone_acceptance_reminder")


def test_reminder_does_not_fire_after_window_expired(awaiting_claim, customer, contractor):
    """Окно уже сработало (авто-подтверждение) — «хвост» серии не шлётся."""
    _make_due(awaiting_claim)
    _expire_window(awaiting_claim)
    assert deadlines_tasks.sweep_domain_deadlines() == 1
    assert notifications_tasks.sweep_reminder_schedules() == 0


# Признак автозакрытия в API (дополнение 26.08 к ADR-133)


def test_auto_satisfy_marks_claim_resolved_auto_without_actor(awaiting_claim):
    _expire_window(awaiting_claim)
    deadlines_tasks.sweep_domain_deadlines()
    _deliver()
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.resolved_auto is True
    assert awaiting_claim.resolved_by_id is None
    assert OutboxEvent.objects.get(topic="warranty.claim_auto_satisfied").payload["auto"] is True


def test_manual_satisfy_records_customer_as_resolver(awaiting_claim, customer):
    services.satisfy_warranty_claim(awaiting_claim, user=customer)
    awaiting_claim.refresh_from_db()
    assert awaiting_claim.resolved_auto is False
    assert awaiting_claim.resolved_by_id == customer.id
    assert OutboxEvent.objects.get(topic="warranty.claim_satisfied").payload["auto"] is False


def test_contractor_decline_records_contractor_as_resolver(claim, contractor):
    services.decline_warranty_claim(claim, user=contractor)
    claim.refresh_from_db()
    assert claim.resolved_auto is False
    assert claim.resolved_by_id == contractor.id


def test_dispute_resolved_by_party_records_actor_as_resolver(claim, customer):
    """Закрытие через общий `/disputes/{id}/resolve` — подписчик переносит
    актора исхода спора в `resolved_by`."""
    dispute = Dispute.objects.get(pk=claim.dispute_id)
    disputes_services.resolve_dispute(dispute, user=customer, resolution_type="warranty_satisfied")
    _deliver()
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.RESOLVED
    assert claim.resolved_auto is False
    assert claim.resolved_by_id == customer.id


def test_dispute_cap_reached_marks_claim_resolved_auto(claim):
    """Потолок 30 дней — системный исход без актора: тоже автозакрытие."""
    dispute = Dispute.objects.get(pk=claim.dispute_id)
    disputes_services.resolve_dispute(dispute, user=None, resolution_type="cap_reached")
    _deliver()
    claim.refresh_from_db()
    assert claim.status == WarrantyClaim.Status.RESOLVED
    assert claim.resolution_type == "cap_reached"
    assert claim.resolved_auto is True
    assert claim.resolved_by_id is None


def test_open_claim_is_not_resolved_auto(awaiting_claim):
    assert awaiting_claim.resolved_auto is False and awaiting_claim.resolved_by_id is None


def test_resolved_auto_requires_no_actor_db_check(claim, customer):
    """CHECK на живом PostgreSQL: автозакрытие с актором — противоречие."""
    from django.db import IntegrityError, transaction

    services.satisfy_warranty_claim(claim, user=customer)
    claim.refresh_from_db()
    claim.resolved_auto = True
    with pytest.raises(IntegrityError), transaction.atomic():
        claim.save(update_fields=["resolved_auto"])


def test_warranty_claim_api_exposes_resolution_actor(warranty_contract, customer, contractor):
    contract, _milestone = warranty_contract
    claim = services.submit_warranty_claim(
        contract, user=customer, description="плитка отошла", evidence=["photo.jpg"]
    )
    resp = _client(customer).get(f"/v1/contracts/{contract.id}/warranty-claims")
    body = resp.json()[0]
    assert body["resolved_auto"] is False and body["resolved_by_id"] is None

    resp = _client(customer).post(f"/v1/warranty-claims/{claim.id}/satisfy", {}, format="json")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["resolved_auto"] is False and body["resolved_by_id"] == str(customer.id)


def test_warranty_claim_api_exposes_auto_resolution(awaiting_claim, customer):
    _expire_window(awaiting_claim)
    deadlines_tasks.sweep_domain_deadlines()
    _deliver()
    resp = _client(customer).get(f"/v1/contracts/{awaiting_claim.contract_id}/warranty-claims")
    body = resp.json()[0]
    assert body["status"] == "resolved" and body["resolution_type"] == "warranty_satisfied"
    assert body["resolved_auto"] is True and body["resolved_by_id"] is None
