"""apps.milestones.services — Э4.6 (docs/tasks/etap-4.md): исполнение —
гейт, сдача, приёмка. Каждый переход и каждый запрет — отдельным тестом
(CLAUDE.md)."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DomainDeadline
from apps.disputes.models import Dispute
from apps.evidence import services as evidence_services
from apps.milestones import selectors, services
from apps.milestones.models import ContractMaterial, Milestone
from apps.notifications import tasks as notifications_tasks
from apps.notifications.models import Notification, ReminderSchedule
from common import relay

from ._execution_helpers import (
    add_checklist_item_with_evidence,
    add_customer_material,
    make_signed_contract_with_leaf,
    make_under_review_contract,
    make_user,
)

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role
_STATUS = Milestone.Status
_PAYMENT_METHOD = Contract.PaymentMethod


@pytest.fixture
def customer():
    return make_user("x001")


@pytest.fixture
def contractor():
    return make_user("x002")


@pytest.fixture
def signed(customer, contractor):
    return make_signed_contract_with_leaf(customer=customer, contractor=contractor)


# --- Гейт: подписан + материалы + фин. условие (tech-spec.md §6.3) ---------


def test_start_milestone_cash_passes_gate_and_starts_contract(signed, customer):
    contract, milestone = signed
    result = services.start_milestone(milestone, user=customer)
    assert result.status == _STATUS.IN_PROGRESS
    assert result.started_at is not None
    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.IN_PROGRESS


def test_start_milestone_idempotent_when_already_in_progress(signed, customer):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    again = services.start_milestone(milestone, user=customer)
    assert again.status == _STATUS.IN_PROGRESS


def test_start_milestone_not_signed_is_blocked(customer, contractor):
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    milestone = services.create_milestone(
        contract, user=customer, title="Работа", amount=Decimal("100.00"), currency="RUB"
    )
    with pytest.raises(services.GateNotSignedError):
        services.start_milestone(milestone, user=customer)


def test_start_milestone_materials_not_ready_is_blocked(signed, customer):
    contract, milestone = signed
    add_customer_material(milestone, received=False)
    with pytest.raises(services.GateMaterialsNotReadyError):
        services.start_milestone(milestone, user=customer)


def test_start_milestone_materials_ready_after_received(signed, customer):
    contract, milestone = signed
    add_customer_material(milestone, received=True)
    result = services.start_milestone(milestone, user=customer)
    assert result.status == _STATUS.IN_PROGRESS


def test_start_milestone_direct_platform_is_honest_stub_awaiting_payment(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_PAYMENT_METHOD.DIRECT_PLATFORM
    )
    with pytest.raises(services.GateFinancialConditionNotMetError) as excinfo:
        services.start_milestone(milestone, user=customer)
    assert excinfo.value.reason == "awaiting_payment"


def test_start_milestone_prepayment_requires_both_confirmations(customer, contractor):
    """Предоплата требует ДВУХ подтверждений — смысл теста Э4.6 сохранён,
    но носитель другой: способ `payment_method=prepayment` упразднён
    (ADR-155), предоплата — это `payment_order=before_start`, и подтверждают
    стороны один и тот же платёж по листу, а не отдельный аванс."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_PAYMENT_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    with pytest.raises(services.GateFinancialConditionNotMetError):
        services.start_milestone(milestone, user=customer)

    services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    with pytest.raises(services.GateFinancialConditionNotMetError):
        services.start_milestone(milestone, user=customer)

    services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    result = services.start_milestone(milestone, user=customer)
    assert result.status == _STATUS.IN_PROGRESS


def test_start_milestone_on_branch_is_forbidden(signed, customer):
    contract, leaf = signed
    # branch: убрать amount у листа, добавить ребёнка — leaf становится веткой
    leaf.amount = None
    leaf.amount_currency = None
    leaf.save(update_fields=["amount", "amount_currency"])
    Milestone.objects.create(
        contract=contract,
        parent=leaf,
        title="Подэтап",
        amount=Decimal("10000.00"),
        amount_currency="RUB",
    )
    with pytest.raises(services.GateNotOnLeafError):
        services.start_milestone(leaf, user=customer)


# --- suspend/resume: уведомление о материалах, ADR-019 ----------------------


def test_raise_material_problem_suspends_milestone(signed, customer, contractor):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    material = add_customer_material(milestone, received=False)

    result = services.raise_material_problem(material, user=contractor, reason="не привезли")
    assert result.status == _STATUS.SUSPENDED
    assert DomainDeadline.objects.filter(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_material_notice"
    ).exists()


def test_raise_material_problem_on_contractor_material_is_forbidden(signed, customer, contractor):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    material = ContractMaterial.objects.create(
        milestone=milestone,
        catalog_item=add_customer_material(milestone).catalog_item,
        description="Свой инструмент",
        unit_price=Decimal("100.00"),
        unit_price_currency="RUB",
        source=ContractMaterial.Source.CONTRACTOR,
    )
    with pytest.raises(services.MaterialProblemNotOnCustomerSourceError):
        services.raise_material_problem(material, user=contractor, reason="жалоба")


def test_confirm_material_received_resumes_and_accumulates_frozen_days(
    signed, customer, contractor
):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    material = add_customer_material(milestone, received=False)
    services.raise_material_problem(material, user=contractor, reason="не привезли")

    # симулируем 3 дня простоя, сдвигая якорь дедлайна в прошлое
    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_material_notice"
    )
    deadline.anchor_at = timezone.now() - timedelta(days=3)
    deadline.save(update_fields=["anchor_at"])

    # ADR-155: два шага — заказчик (источник) передал, исполнитель получил.
    services.confirm_material_handed_over(material, user=customer)
    result = services.confirm_material_received(material, user=contractor)
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.IN_PROGRESS
    assert milestone.frozen_days == 3
    assert result.received is True


def test_shift_dependent_deadlines_shifts_dependent_milestone(signed, customer, contractor):
    contract, milestone = signed
    # Прямое создание ORM (не services.create_milestone) — тот уже требует
    # draft/under_review (_assert_editable), а фикстура `signed` подписана;
    # здесь тестируется ТОЛЬКО сдвиг дедлайнов, не создание структуры.
    original_deadline = timezone.now() + timedelta(days=10)
    dependent = Milestone.objects.create(
        contract=contract,
        title="Следующий этап",
        amount=Decimal("5000.00"),
        amount_currency="RUB",
        depends_on=milestone,
        deadline=original_deadline,
    )
    services.shift_dependent_deadlines(milestone, by_days=3)
    dependent.refresh_from_db()
    assert dependent.deadline == original_deadline + timedelta(days=3)


# --- submit: формальная сдача (tech-spec.md §8.5) ---------------------------


def test_submit_without_required_evidence_is_allowed(signed, customer, contractor):
    """ADR-164 (решение владельца 05.09): непокрытый `required_evidence`
    больше НЕ запрещает сдачу — раньше здесь ожидался
    `RequiredEvidenceNotCoveredError`. Полноту работы судит заказчик на
    приёмке: у него есть отклонение по конкретному пункту (ADR-017)."""
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    add_checklist_item_with_evidence(milestone)

    result = services.submit_milestone(milestone, user=contractor)

    assert result.status == _STATUS.UNDER_ACCEPTANCE
    assert result.submitted_at is not None


def test_uncovered_required_evidence_lists_items_without_files(signed, customer, contractor):
    """Список непокрытых пунктов — в порядке чек-листа: из него собирается и
    предупреждение исполнителю в диалоге сдачи, и пометка заказчику."""
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    first = add_checklist_item_with_evidence(milestone)
    second = add_checklist_item_with_evidence(milestone)

    assert selectors.uncovered_required_evidence(milestone) == [first.id, second.id]

    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=first.id,
    )
    assert selectors.uncovered_required_evidence(milestone) == [second.id]


def test_uncovered_required_evidence_ignores_optional_items(signed, customer, contractor):
    """Пункт без `required_evidence` подтверждать нечем — в списке его быть не
    должно, иначе предупреждение врёт на каждом обычном чек-листе."""
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    milestone.checklist_items.create(
        description="Мусор вывезен", measurable_criterion="Площадка чистая", required_evidence=[]
    )

    assert selectors.uncovered_required_evidence(milestone) == []


def test_uncovered_required_evidence_is_empty_when_all_covered(signed, customer, contractor):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )

    assert selectors.uncovered_required_evidence(milestone) == []
    assert services.submit_milestone(milestone, user=contractor).status == _STATUS.UNDER_ACCEPTANCE


def test_evidence_bound_to_stage_only_does_not_cover_checklist_item(signed, customer, contractor):
    """Ровно та ловушка из жалобы 05.09: фото приложили «к этапу», а не к
    пункту (`checklist_item_id=None`) — покрытия пункта от этого не
    появляется. До ADR-164 это молча превращалось в отказ сдачи с текстом про
    UUID; теперь это видимая пометка, а сдача проходит."""
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
    )

    assert selectors.uncovered_required_evidence(milestone) == [item.id]
    assert services.submit_milestone(milestone, user=contractor).status == _STATUS.UNDER_ACCEPTANCE


def test_submit_with_evidence_covered_moves_to_under_acceptance(signed, customer, contractor):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )
    result = services.submit_milestone(milestone, user=contractor)
    assert result.status == _STATUS.UNDER_ACCEPTANCE
    assert result.submitted_at is not None
    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_acceptance"
    )
    assert deadline.anchor_at is not None  # заякорен place_notification


# --- accept/reject/auto-accept ----------------------------------------------


def _submitted_milestone(contract, milestone, *, customer, contractor):
    services.start_milestone(milestone, user=customer)
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )
    services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    return item


def test_accept_by_customer_moves_to_accepted(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    result = services.accept_milestone(milestone, user=customer)
    assert result.status == _STATUS.ACCEPTED
    assert result.accepted_at is not None


def test_accept_by_contractor_is_forbidden(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    with pytest.raises(contracts_services.NotAPartyError):
        services.accept_milestone(milestone, user=contractor)


def test_auto_accept_via_sweep_after_deadline_fires(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)

    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_acceptance"
    )
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])

    fired = deadlines_tasks.sweep_domain_deadlines()
    assert fired == 1
    delivered = relay.deliver_due_events()
    assert delivered >= 1

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.ACCEPTED


def test_reject_without_checklist_item_id_is_422(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    with pytest.raises(services.ChecklistItemRequiredError):
        services.reject_milestone(
            milestone, user=customer, checklist_item_id=None, evidence=["photo"]
        )


def test_reject_without_evidence_is_forbidden(signed, customer, contractor):
    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    with pytest.raises(services.EvidenceRequiredError):
        services.reject_milestone(milestone, user=customer, checklist_item_id=item.id, evidence=[])


def test_reject_moves_to_disputed_and_opens_dispute_via_relay(signed, customer, contractor):
    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    result = services.reject_milestone(
        milestone, user=customer, checklist_item_id=item.id, evidence=["photo-defect.jpg"]
    )
    assert result.status == _STATUS.DISPUTED

    delivered = relay.deliver_due_events()
    assert delivered >= 1
    dispute = Dispute.objects.get(milestone=milestone)
    assert dispute.checklist_item_id == item.id
    assert dispute.status == Dispute.Status.OPEN


def test_dispute_resolved_accepted_returns_milestone_to_accepted(signed, customer, contractor):
    from apps.disputes import services as disputes_services

    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.reject_milestone(
        milestone, user=customer, checklist_item_id=item.id, evidence=["photo-defect.jpg"]
    )
    relay.deliver_due_events()
    dispute = Dispute.objects.get(milestone=milestone)

    disputes_services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    relay.deliver_due_events()

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.ACCEPTED


def test_dispute_cap_sweep_resolves_cap_reached(signed, customer, contractor):

    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.reject_milestone(
        milestone, user=customer, checklist_item_id=item.id, evidence=["photo-defect.jpg"]
    )
    relay.deliver_due_events()
    dispute = Dispute.objects.get(milestone=milestone)

    # Этап 7 (ADR-131): на субъекте «спор» теперь ДВА дедлайна — потолок
    # 30 дней и окно ответа второй стороны, поэтому фильтр по kind.
    cap_deadline = DomainDeadline.objects.get(
        subject_type="dispute", subject_id=dispute.id, kind="dispute_cap"
    )
    cap_deadline.deadline_at = timezone.now() - timedelta(hours=1)
    cap_deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    relay.deliver_due_events()

    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.resolution_type == "cap_reached"


# --- закрытие окна приёмки решением заказчика (fix 26.08) --------------------
#
# Баг: после ручной приёмки/отклонения дедлайн `milestone_acceptance`
# оставался активным до истечения 48 ч, и `sweep_reminder_schedules` слал
# заказчику оставшиеся точки усиленной серии «примите этап» (50/75/90/99 %,
# ReminderPointConfig из apps/notifications/migrations/0002) по уже принятому
# или отклонённому этапу.

_REMINDER_TEMPLATE = "milestone_acceptance_reminder"


def _acceptance_deadlines(milestone):
    return DomainDeadline.objects.filter(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_acceptance"
    ).order_by("anchor_at")


def _make_all_reminders_due(deadline) -> int:
    """Серия ещё в будущем (точки 50-99 % от 48 ч) — сдвигаем её в прошлое,
    как если бы прошло время: свип должен решать по состоянию дедлайна, а не
    по тому, наступила ли точка."""
    return ReminderSchedule.objects.filter(deadline=deadline).update(
        fire_at=timezone.now() - timedelta(minutes=1)
    )


def _reminders_sent(customer) -> int:
    return Notification.objects.filter(recipient=customer, template=_REMINDER_TEMPLATE).count()


def _reject(milestone, item, *, customer):
    return services.reject_milestone(
        milestone, user=customer, checklist_item_id=item.id, evidence=["photo-defect.jpg"]
    )


def test_submit_schedules_reminder_series_for_customer(signed, customer, contractor):
    """Предпосылка остальных тестов блока: сдача заводит серию (точки > 0)
    на дедлайн приёмки, получатель — заказчик."""
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    deadline = _acceptance_deadlines(milestone).get()
    schedules = ReminderSchedule.objects.filter(deadline=deadline)
    assert schedules.count() == 4  # 0.5 / 0.75 / 0.9 / 0.99
    assert {s.recipient_id for s in schedules} == {customer.id}
    assert all(s.fired_at is None for s in schedules)


def test_manual_accept_closes_acceptance_deadline(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.accept_milestone(milestone, user=customer)

    deadline = _acceptance_deadlines(milestone).get()
    assert deadline.fired_at is not None
    assert deadline.outcome == "accepted"
    # Экран приёмки: окна больше нет.
    assert selectors.acceptance_window_status(milestone) == {
        "placed_in_cabinet": False,
        "deadline_at": None,
        "hours_left": None,
    }


def test_manual_accept_stops_remaining_reminders(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.accept_milestone(milestone, user=customer)
    deadline = _acceptance_deadlines(milestone).get()
    assert _make_all_reminders_due(deadline) == 4
    sent_before = _reminders_sent(customer)

    assert notifications_tasks.sweep_reminder_schedules() == 0
    assert _reminders_sent(customer) == sent_before
    assert not ReminderSchedule.objects.filter(deadline=deadline, fired_at__isnull=False).exists()


def test_manual_accept_then_overdue_deadline_is_not_fired_by_sweep(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.accept_milestone(milestone, user=customer)
    deadline = _acceptance_deadlines(milestone).get()
    DomainDeadline.objects.filter(pk=deadline.pk).update(
        deadline_at=timezone.now() - timedelta(hours=1)
    )

    assert deadlines_tasks.sweep_domain_deadlines() == 0
    relay.deliver_due_events()
    deadline.refresh_from_db()
    assert deadline.outcome == "accepted"  # не перезаписан `timed_out`
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.ACCEPTED


def test_reject_closes_acceptance_deadline_and_stops_reminders(signed, customer, contractor):
    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    _reject(milestone, item, customer=customer)

    deadline = _acceptance_deadlines(milestone).get()
    assert deadline.fired_at is not None
    assert deadline.outcome == "rejected"

    _make_all_reminders_due(deadline)
    sent_before = _reminders_sent(customer)
    assert notifications_tasks.sweep_reminder_schedules() == 0
    assert _reminders_sent(customer) == sent_before
    DomainDeadline.objects.filter(pk=deadline.pk).update(
        deadline_at=timezone.now() - timedelta(hours=1)
    )
    assert deadlines_tasks.sweep_domain_deadlines() == 0


def test_dispute_resolved_accept_after_reject_has_no_active_deadline(signed, customer, contractor):
    """Приёмка по исходу спора (handlers.handle_dispute_resolved ->
    finalize_acceptance): окно закрыто ещё в reject, повторное закрытие —
    NOOP, а не DeadlineAlreadyFiredError."""
    from apps.disputes import services as disputes_services

    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    _reject(milestone, item, customer=customer)
    relay.deliver_due_events()
    dispute = Dispute.objects.get(milestone=milestone)
    disputes_services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    relay.deliver_due_events()

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.ACCEPTED
    deadline = _acceptance_deadlines(milestone).get()
    assert deadline.outcome == "rejected"  # исход первого закрытия сохранён


def _resubmitted_after_fix(milestone, item, *, customer, contractor):
    from apps.disputes import services as disputes_services

    _reject(milestone, item, customer=customer)
    relay.deliver_due_events()
    dispute = Dispute.objects.get(milestone=milestone)
    fix_request = disputes_services.request_fix(dispute, user=customer)
    disputes_services.resubmit_fix(fix_request, user=contractor, comment="исправил")
    relay.deliver_due_events()
    milestone.refresh_from_db()
    assert milestone.status == _STATUS.UNDER_ACCEPTANCE


def test_resubmit_fix_opens_new_deadline_and_new_reminder_series(signed, customer, contractor):
    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    _resubmitted_after_fix(milestone, item, customer=customer, contractor=contractor)

    old, new = list(_acceptance_deadlines(milestone))
    assert old.fired_at is not None and old.outcome == "rejected"
    assert new.fired_at is None and new.anchor_at is not None
    assert ReminderSchedule.objects.filter(deadline=new, fired_at__isnull=True).count() == 4

    # Старая серия молчит, новая — уходит заказчику.
    _make_all_reminders_due(old)
    _make_all_reminders_due(new)
    sent_before = _reminders_sent(customer)
    assert notifications_tasks.sweep_reminder_schedules() == 4
    assert _reminders_sent(customer) == sent_before + 4
    assert not ReminderSchedule.objects.filter(deadline=old, fired_at__isnull=False).exists()
    assert ReminderSchedule.objects.filter(deadline=new, fired_at__isnull=True).count() == 0


def test_reminder_sweep_is_idempotent_after_manual_accept_of_resubmitted(
    signed, customer, contractor
):
    contract, milestone = signed
    item = _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    _resubmitted_after_fix(milestone, item, customer=customer, contractor=contractor)
    old, new = list(_acceptance_deadlines(milestone))
    _make_all_reminders_due(old)
    _make_all_reminders_due(new)

    services.accept_milestone(milestone, user=customer)

    new.refresh_from_db()
    assert new.outcome == "accepted"
    sent_before = _reminders_sent(customer)
    assert notifications_tasks.sweep_reminder_schedules() == 0
    assert notifications_tasks.sweep_reminder_schedules() == 0  # повторный проход
    assert _reminders_sent(customer) == sent_before
    DomainDeadline.objects.filter(subject_type="milestone", subject_id=milestone.id).update(
        deadline_at=timezone.now() - timedelta(hours=1)
    )
    assert deadlines_tasks.sweep_domain_deadlines() == 0
    assert deadlines_tasks.sweep_domain_deadlines() == 0


def test_auto_accept_after_sweep_leaves_timed_out_outcome(signed, customer, contractor):
    """Автоприёмка: дедлайн уже сработал по свипу — finalize_acceptance не
    пытается закрыть его повторно, исход остаётся `timed_out`."""
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    deadline = _acceptance_deadlines(milestone).get()
    DomainDeadline.objects.filter(pk=deadline.pk).update(
        deadline_at=timezone.now() - timedelta(hours=1)
    )
    assert deadlines_tasks.sweep_domain_deadlines() == 1
    relay.deliver_due_events()

    milestone.refresh_from_db()
    assert milestone.status == _STATUS.ACCEPTED
    deadline.refresh_from_db()
    assert deadline.outcome == "timed_out"


# --- accepted -> paid, contract completed/warranty ---------------------------


def test_confirm_payment_both_sides_moves_to_paid_and_completes_contract(
    signed, customer, contractor
):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.accept_milestone(milestone, user=customer)

    result = services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    assert result.status == _STATUS.ACCEPTED  # ещё не обе стороны

    result = services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    assert result.status == _STATUS.PAID

    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.WARRANTY


def test_confirm_payment_wrong_side_is_forbidden(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.accept_milestone(milestone, user=customer)
    with pytest.raises(services.WrongConfirmationSideError):
        services.confirm_payment(milestone, user=customer, side=_ROLE.CONTRACTOR)


def test_contract_warranty_sweep_closes_contract(signed, customer, contractor):
    contract, milestone = signed
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    services.accept_milestone(milestone, user=customer)
    services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)

    contract.refresh_from_db()
    warranty_deadline = DomainDeadline.objects.get(
        subject_type="contract", subject_id=contract.id, kind="contract_warranty"
    )
    warranty_deadline.deadline_at = timezone.now() - timedelta(hours=1)
    warranty_deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    relay.deliver_due_events()

    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.CLOSED


# --- расторжение: заглушки эндпоинтов (ADR-028) -----------------------------


def test_terminate_by_customer_from_pending_start(customer, contractor):
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    result = contracts_services.terminate_by_customer(contract, user=customer, reason="передумал")
    assert result.execution_status == Contract.ExecutionStatus.TERMINATED_BY_CUSTOMER


def test_terminate_by_contractor_requires_reason(signed, customer, contractor):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    with pytest.raises(contracts_services.TerminationReasonRequiredError):
        contracts_services.terminate_by_contractor(contract, user=contractor, reason="")


def test_terminate_by_contractor_from_in_progress(signed, customer, contractor):
    contract, milestone = signed
    services.start_milestone(milestone, user=customer)
    result = contracts_services.terminate_by_contractor(
        contract, user=contractor, reason="заказчик не даёт доступ"
    )
    assert result.execution_status == Contract.ExecutionStatus.TERMINATED_BY_CONTRACTOR


def test_terminate_by_contractor_before_start_is_invalid_transition(customer, contractor):
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    with pytest.raises(contracts_services.InvalidExecutionTransitionError):
        contracts_services.terminate_by_contractor(contract, user=contractor, reason="основание")


# --- ADR-140: окно приёмки — из условий договора ---------------------------


def test_submit_uses_acceptance_window_from_contract_form_data(signed, customer, contractor):
    contract, milestone = signed
    contract.form_data = {**(contract.form_data or {}), "acceptance_window_hours": 72}
    contract.save(update_fields=["form_data"])
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_acceptance"
    )
    assert deadline.duration_override == timedelta(hours=72)
    assert deadline.anchor_at is not None
    assert deadline.deadline_at == deadline.anchor_at + timedelta(hours=72)


def test_submit_without_window_in_contract_falls_back_to_kind_duration(
    signed, customer, contractor
):
    contract, milestone = signed
    contract.form_data = {
        k: v for k, v in (contract.form_data or {}).items() if k != "acceptance_window_hours"
    }
    contract.save(update_fields=["form_data"])
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_acceptance"
    )
    assert deadline.duration_override is None
    assert deadline.deadline_at == deadline.anchor_at + timedelta(hours=48)


def test_submit_ignores_invalid_acceptance_window_values(signed, customer, contractor):
    contract, milestone = signed
    contract.form_data = {**(contract.form_data or {}), "acceptance_window_hours": 0}
    contract.save(update_fields=["form_data"])
    _submitted_milestone(contract, milestone, customer=customer, contractor=contractor)
    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone.id, kind="milestone_acceptance"
    )
    assert deadline.duration_override is None
