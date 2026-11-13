"""ADR-138: автозакрытие сделки без движения (ADR-137 требование 8).

Учёт движения (`Contract.last_activity_at`, подписчик «*»), дедлайн
`contract_idle` (одна строка, перенос при движении), предупреждение за две
недели обеим сторонам, срабатывание (закрытие / отсрочка при незавершённых
действиях / NOOP при гонке), идемпотентность свипа, неприкосновенность
`warranty`/черновиков. Каждый переход и каждый запрет — отдельным тестом
(CLAUDE.md)."""

from __future__ import annotations

import importlib
from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.contracts import handlers, services
from apps.contracts.models import Contract, ContractParty
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from apps.milestones import services as milestones_services
from apps.milestones.models import Milestone
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.notifications import tasks as notifications_tasks
from apps.notifications.models import Notification, ReminderPointConfig, ReminderSchedule
from common import relay
from common.fsm import InvalidTransitionError
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_EXEC = Contract.ExecutionStatus
_STATUS = Milestone.Status
_ROLE = ContractParty.Role
_IDLE = services.IDLE_DEADLINE_KIND
_RETRY = services.IDLE_RETRY_DEADLINE_KIND


@pytest.fixture
def customer():
    return make_user("i001")


@pytest.fixture
def contractor():
    return make_user("i002")


@pytest.fixture
def in_progress(customer, contractor):
    """Подписанный договор с одним листом, гейт пройден -> `in_progress`.
    Шум событий согласования/подписания доставлен и убран."""
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    relay.deliver_due_events()
    Notification.objects.all().delete()
    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.IN_PROGRESS
    return contract, milestone


def _idle_deadlines(contract, *, kind: str = _IDLE):
    return DomainDeadline.objects.filter(subject_type="contract", subject_id=contract.id, kind=kind)


def _active_idle(contract) -> DomainDeadline:
    return _idle_deadlines(contract).get(fired_at__isnull=True)


def _fire_idle(contract, *, kind: str = _IDLE) -> None:
    """Сдвинуть активный дедлайн в прошлое и прогнать свип + реле."""
    deadline = _idle_deadlines(contract, kind=kind).get(fired_at__isnull=True)
    deadline.deadline_at = timezone.now() - timedelta(minutes=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    _deliver_all()


def _deliver_all() -> None:
    """Реле берёт батч ДО доставки: события, опубликованные подписчиками
    (contract.auto_closed из обработчика domain_deadline.fired), уходят
    следующим проходом — как в проде через 5 с."""
    while relay.deliver_due_events():
        pass


def _activity_event(*, topic: str, subject: dict, payload: dict, actor_user, at=None):
    return OutboxEvent.objects.create(
        topic=topic,
        occurred_at=at or timezone.now(),
        actor={"user_id": str(actor_user.id)} if actor_user is not None else {},
        subject=subject,
        payload=payload,
    )


def _contract_event(contract, *, topic: str, actor_user, at=None):
    return _activity_event(
        topic=topic,
        subject={"type": "contract", "id": str(contract.id)},
        payload={},
        actor_user=actor_user,
        at=at,
    )


def _templates(user) -> list[str]:
    return list(Notification.objects.filter(recipient=user).values_list("template", flat=True))


# --- 1. Учёт движения --------------------------------------------------------


def test_backfill_migration_takes_latest_event_or_created_at(customer, contractor):
    """Миграция 0009: max(дата последнего события по договору, created_at);
    функция миграции вызывается напрямую (тот же приём, что
    apps/milestones/tests/test_sphere_dedupe_migration)."""
    from django.apps import apps as live_apps

    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    later = timezone.now() + timedelta(days=3)
    OutboxEvent.objects.create(
        topic="milestone.updated",
        occurred_at=later,
        actor={"user_id": str(customer.id)},
        subject={"type": "milestone", "id": str(uuid4()), "contract_id": str(contract.id)},
        payload={},
    )
    Contract.objects.filter(pk=contract.pk).update(last_activity_at=contract.created_at)

    migration = importlib.import_module("apps.contracts.migrations.0009_contract_last_activity_at")
    migration.backfill_last_activity(live_apps, None)

    contract.refresh_from_db()
    assert contract.last_activity_at == later


def test_backfill_migration_falls_back_to_created_at(customer, contractor):
    from django.apps import apps as live_apps

    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    OutboxEvent.objects.all().delete()
    Contract.objects.filter(pk=contract.pk).update(last_activity_at=timezone.now())

    migration = importlib.import_module("apps.contracts.migrations.0009_contract_last_activity_at")
    migration.backfill_last_activity(live_apps, None)

    contract.refresh_from_db()
    assert contract.last_activity_at == contract.created_at


def test_start_execution_opens_idle_deadline_and_warning_series_for_both_parties(
    in_progress, customer, contractor
):
    contract, _ = in_progress
    deadline = _active_idle(contract)
    duration = DeadlineKindConfig.objects.get(kind=_IDLE).duration
    assert duration == timedelta(days=90)
    assert deadline.starts_from == DomainDeadline.StartsFrom.EVENT
    assert deadline.anchor_at == contract.last_activity_at
    assert deadline.deadline_at == deadline.anchor_at + duration
    schedules = ReminderSchedule.objects.filter(deadline=deadline)
    assert {s.recipient_id for s in schedules} == {customer.id, contractor.id}
    assert {s.template for s in schedules} == {"contract.idle_warning"}


@pytest.mark.parametrize(
    ("topic", "subject_kind"),
    [
        ("milestone.submitted", "child"),
        ("payment.payer_confirmed", "child"),
        ("dispute.responded", "child"),
        ("evidence.received", "child"),
        ("warranty.claim_submitted", "child"),
        ("message.created", "contract"),
        ("negotiation.revised", "contract"),
        ("contract.amended", "contract"),
        ("amendment.sent", "payload"),
    ],
)
def test_every_event_family_moves_last_activity_and_reschedules_deadline(
    in_progress, customer, topic, subject_kind
):
    """Каждое семейство событий договорного контура двигает метку и
    переносит ТУ ЖЕ строку дедлайна (не плодит новых)."""
    contract, _ = in_progress
    before = _active_idle(contract)
    at = timezone.now() + timedelta(days=10)
    if subject_kind == "child":
        subject = {"type": topic.split(".")[0], "id": str(uuid4()), "contract_id": str(contract.id)}
        payload = {}
    elif subject_kind == "contract":
        subject = {"type": "contract", "id": str(contract.id)}
        payload = {}
    else:
        subject = {"type": "amendment", "id": str(uuid4())}
        payload = {"contract_id": str(contract.id)}
    event = _activity_event(
        topic=topic, subject=subject, payload=payload, actor_user=customer, at=at
    )

    handlers.handle_contract_activity(event)

    contract.refresh_from_db()
    assert contract.last_activity_at == at
    after = _active_idle(contract)
    assert after.id == before.id
    assert after.anchor_at == at
    assert after.deadline_at == at + timedelta(days=90)
    assert _idle_deadlines(contract).count() == 1


def test_system_event_without_actor_is_not_activity(in_progress):
    contract, _ = in_progress
    before = _active_idle(contract)
    event = _activity_event(
        topic="milestone.auto_accepted",
        subject={"type": "milestone", "id": str(uuid4()), "contract_id": str(contract.id)},
        payload={},
        actor_user=None,
        at=timezone.now() + timedelta(days=5),
    )
    handlers.handle_contract_activity(event)
    contract.refresh_from_db()
    assert contract.last_activity_at == before.anchor_at
    assert _active_idle(contract).deadline_at == before.deadline_at


def test_foreign_topic_family_is_not_activity(in_progress, customer):
    contract, _ = in_progress
    before = _active_idle(contract)
    event = _contract_event(
        contract,
        topic="social.consent_recorded",
        actor_user=customer,
        at=timezone.now() + timedelta(days=5),
    )
    handlers.handle_contract_activity(event)
    contract.refresh_from_db()
    assert contract.last_activity_at == before.anchor_at


def test_older_activity_is_a_noop(in_progress, customer):
    """Реле не гарантирует порядок между темами — более ранняя метка не
    откатывает более позднюю."""
    contract, _ = in_progress
    before = _active_idle(contract)
    event = _contract_event(
        contract,
        topic="message.created",
        actor_user=customer,
        at=contract.last_activity_at - timedelta(days=1),
    )
    handlers.handle_contract_activity(event)
    contract.refresh_from_db()
    assert contract.last_activity_at == before.anchor_at
    assert _active_idle(contract).deadline_at == before.deadline_at


def test_real_chat_message_moves_the_mark_through_relay(in_progress, customer):
    """Сквозной путь ADR-137 «включая сообщения в чате»: настоящий
    `apps.messaging.services.send_message` -> outbox -> реле -> подписчик."""
    # Через importlib: import-linter запрещает contracts -> messaging даже из
    # тестов, а здесь нужен именно настоящий издатель (сквозной путь).
    messaging_services = importlib.import_module("apps.messaging.services")

    contract, _ = in_progress
    before = contract.last_activity_at
    messaging_services.send_message(contract, user=customer, body="Когда начнём?")
    relay.deliver_due_events()
    contract.refresh_from_db()
    assert contract.last_activity_at > before
    assert _active_idle(contract).anchor_at == contract.last_activity_at


def test_replanned_series_keeps_one_point_per_party(in_progress, customer):
    contract, _ = in_progress
    for day in (1, 2):
        event = _contract_event(
            contract,
            topic="message.created",
            actor_user=customer,
            at=timezone.now() + timedelta(days=day),
        )
        handlers.handle_contract_activity(event)
    deadline = _active_idle(contract)
    points = ReminderPointConfig.objects.get(kind=_IDLE).points
    assert ReminderSchedule.objects.filter(deadline=deadline).count() == 2 * len(points)


# --- 2. Предупреждение за 14 дней ---------------------------------------------


def test_warning_point_is_fourteen_days_before_deadline(in_progress):
    contract, _ = in_progress
    deadline = _active_idle(contract)
    schedule = ReminderSchedule.objects.filter(deadline=deadline).first()
    assert schedule is not None
    assert schedule.is_final is True
    assert abs((deadline.deadline_at - schedule.fire_at) - timedelta(days=14)) < timedelta(
        seconds=1
    )


def test_warning_is_placed_for_both_parties_with_days_left(in_progress, customer, contractor):
    contract, _ = in_progress
    deadline = _active_idle(contract)
    ReminderSchedule.objects.filter(deadline=deadline).update(
        fire_at=timezone.now() - timedelta(minutes=1)
    )
    notifications_tasks.sweep_reminder_schedules()

    for user in (customer, contractor):
        notification = Notification.objects.get(recipient=user, template="contract.idle_warning")
        assert notification.legal_significance is True
        assert notification.placed_in_cabinet_at is not None
        assert notification.payload["days_left"] == 89
        assert notification.payload["contract_title"] == contract.title
        assert notification.contract_id == contract.id


def test_activity_after_warning_replans_series_from_scratch(in_progress, customer):
    contract, _ = in_progress
    deadline = _active_idle(contract)
    ReminderSchedule.objects.filter(deadline=deadline).update(
        fire_at=timezone.now() - timedelta(minutes=1)
    )
    notifications_tasks.sweep_reminder_schedules()
    assert ReminderSchedule.objects.filter(deadline=deadline, fired_at__isnull=False).count() == 2

    event = _contract_event(
        contract,
        topic="message.created",
        actor_user=customer,
        at=timezone.now() + timedelta(seconds=1),
    )
    handlers.handle_contract_activity(event)

    schedules = ReminderSchedule.objects.filter(deadline=deadline)
    assert schedules.count() == 2
    assert not schedules.filter(fired_at__isnull=False).exists()
    assert Notification.objects.filter(template="contract.idle_warning").count() == 2


# --- 3. Срабатывание ---------------------------------------------------------


def test_idle_deadline_fires_and_auto_closes_contract(in_progress, customer, contractor):
    contract, _ = in_progress
    _fire_idle(contract)

    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.CLOSED
    event = OutboxEvent.objects.get(topic="contract.auto_closed")
    assert event.actor == {}
    assert event.payload["reason"] == "idle"
    assert event.payload["idle_days"] == 0
    assert event.payload["contract_id"] == str(contract.id)
    assert _idle_deadlines(contract).get().outcome == "auto_closed"
    for user in (customer, contractor):
        assert "contract.auto_closed" in _templates(user)
    assert not OutboxEvent.objects.filter(topic="contract.closed").exists()
    assert not OutboxEvent.objects.filter(topic="contract.completed").exists()


def test_auto_close_idle_days_counts_from_last_activity(in_progress):
    contract, _ = in_progress
    Contract.objects.filter(pk=contract.pk).update(
        last_activity_at=timezone.now() - timedelta(days=91)
    )
    _fire_idle(contract)
    event = OutboxEvent.objects.get(topic="contract.auto_closed")
    assert event.payload["idle_days"] == 91


def test_activity_between_sweep_and_delivery_is_a_noop(in_progress, customer):
    """Гонка: свип выстрелил, движение случилось до доставки события."""
    contract, _ = in_progress
    deadline = _active_idle(contract)
    deadline.deadline_at = timezone.now() - timedelta(minutes=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()

    late = _contract_event(contract, topic="message.created", actor_user=customer)
    handlers.handle_contract_activity(late)
    relay.deliver_due_events()

    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.IN_PROGRESS
    assert not OutboxEvent.objects.filter(topic="contract.auto_closed").exists()
    deadline.refresh_from_db()
    assert deadline.outcome == "stale"
    fresh = _active_idle(contract)
    assert fresh.id != deadline.id
    assert fresh.anchor_at == contract.last_activity_at


def test_repeated_delivery_of_fired_event_does_not_close_twice(in_progress):
    contract, _ = in_progress
    _fire_idle(contract)
    fired = OutboxEvent.objects.get(topic="domain_deadline.fired", payload__kind=_IDLE)
    handlers.handle_deadline_fired(fired)
    handlers.handle_deadline_fired(fired)
    assert OutboxEvent.objects.filter(topic="contract.auto_closed").count() == 1
    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.CLOSED


@pytest.mark.parametrize("status", [_STATUS.UNDER_ACCEPTANCE, _STATUS.ACCEPTED])
def test_pending_milestone_postpones_auto_close(in_progress, customer, contractor, status):
    contract, milestone = in_progress
    milestone.status = status
    milestone.save(update_fields=["status"])
    _fire_idle(contract)

    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.IN_PROGRESS
    assert not OutboxEvent.objects.filter(topic="contract.auto_closed").exists()
    assert _idle_deadlines(contract).get().outcome == "postponed"
    retry = _idle_deadlines(contract, kind=_RETRY).get(fired_at__isnull=True)
    assert retry.deadline_at - retry.anchor_at == timedelta(days=14)
    blocked = OutboxEvent.objects.get(topic="contract.idle_blocked")
    assert blocked.payload["pending"] == {status: 1}
    assert blocked.payload["retry_days"] == 14
    for user in (customer, contractor):
        assert "contract.idle_blocked" in _templates(user)


@pytest.mark.parametrize("status", [_STATUS.PENDING, _STATUS.IN_PROGRESS, _STATUS.SUSPENDED])
def test_unfinished_but_not_pending_milestone_does_not_block(in_progress, status):
    contract, milestone = in_progress
    milestone.status = status
    milestone.save(update_fields=["status"])
    _fire_idle(contract)
    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.CLOSED


def test_retry_deadline_closes_when_pending_actions_are_gone(in_progress):
    contract, milestone = in_progress
    milestone.status = _STATUS.ACCEPTED
    milestone.save(update_fields=["status"])
    _fire_idle(contract)
    milestone.status = _STATUS.PAID
    milestone.save(update_fields=["status"])

    _fire_idle(contract, kind=_RETRY)

    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.CLOSED
    assert _idle_deadlines(contract, kind=_RETRY).get().outcome == "auto_closed"


def test_retry_deadline_postpones_again_while_still_blocked(in_progress):
    contract, milestone = in_progress
    milestone.status = _STATUS.ACCEPTED
    milestone.save(update_fields=["status"])
    _fire_idle(contract)
    _fire_idle(contract, kind=_RETRY)

    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.IN_PROGRESS
    assert _idle_deadlines(contract, kind=_RETRY).count() == 2
    assert OutboxEvent.objects.filter(topic="contract.idle_blocked").count() == 2


def test_activity_during_retry_closes_retry_and_restarts_idle(in_progress, customer):
    contract, milestone = in_progress
    milestone.status = _STATUS.ACCEPTED
    milestone.save(update_fields=["status"])
    _fire_idle(contract)
    retry = _idle_deadlines(contract, kind=_RETRY).get(fired_at__isnull=True)

    event = _activity_event(
        topic="payment.payer_confirmed",
        subject={"type": "payment", "id": str(uuid4()), "contract_id": str(contract.id)},
        payload={},
        actor_user=customer,
    )
    handlers.handle_contract_activity(event)

    retry.refresh_from_db()
    assert retry.fired_at is not None
    assert retry.outcome == "activity"
    contract.refresh_from_db()
    fresh = _active_idle(contract)
    assert fresh.anchor_at == contract.last_activity_at
    assert fresh.deadline_at == fresh.anchor_at + timedelta(days=90)


# --- 4. FSM и состояния, которые не затрагиваются -----------------------------


def test_fsm_auto_close_idle_is_declared_only_from_in_progress():
    services.EXECUTION_FSM.assert_transition("auto_close_idle", _EXEC.IN_PROGRESS)
    for source in (_EXEC.PENDING_START, _EXEC.WARRANTY, _EXEC.COMPLETED, _EXEC.CLOSED):
        with pytest.raises(InvalidTransitionError):
            services.EXECUTION_FSM.assert_transition("auto_close_idle", source)


def test_complete_execution_closes_idle_deadline_without_event(in_progress):
    contract, _ = in_progress
    services.complete_execution(contract)
    deadline = _idle_deadlines(contract).get()
    assert deadline.fired_at is not None
    assert deadline.outcome == "execution_finished"
    assert not OutboxEvent.objects.filter(
        topic="domain_deadline.fired", payload__kind=_IDLE
    ).exists()
    # Серия предупреждений больше не отбирается свипом напоминаний.
    ReminderSchedule.objects.filter(deadline=deadline).update(
        fire_at=timezone.now() - timedelta(minutes=1)
    )
    notifications_tasks.sweep_reminder_schedules()
    assert not Notification.objects.filter(template="contract.idle_warning").exists()


def test_warranty_contract_has_no_idle_deadline_and_ignores_activity(in_progress, customer):
    contract, _ = in_progress
    services.complete_execution(contract)
    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.WARRANTY

    event = _activity_event(
        topic="warranty.claim_submitted",
        subject={"type": "warranty_claim", "id": str(uuid4()), "contract_id": str(contract.id)},
        payload={},
        actor_user=customer,
        at=timezone.now() + timedelta(days=1),
    )
    handlers.handle_contract_activity(event)

    contract.refresh_from_db()
    assert contract.last_activity_at == event.occurred_at
    assert not _idle_deadlines(contract).filter(fired_at__isnull=True).exists()
    assert DomainDeadline.objects.filter(
        subject_id=contract.id, kind="contract_warranty", fired_at__isnull=True
    ).exists()


def test_stale_idle_event_for_warranty_contract_is_a_noop(in_progress):
    """Сработавший `contract_idle` доставлен после того, как договор ушёл в
    гарантию (свип и complete_execution в одну минуту) — статус не трогаем."""
    contract, _ = in_progress
    deadline = _active_idle(contract)
    deadline.deadline_at = timezone.now() - timedelta(minutes=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    services.complete_execution(contract)
    relay.deliver_due_events()
    contract.refresh_from_db()
    assert contract.execution_status == _EXEC.WARRANTY
    assert not OutboxEvent.objects.filter(topic="contract.auto_closed").exists()


def test_terminate_by_customer_closes_idle_deadline(in_progress, customer):
    contract, _ = in_progress
    services.terminate_by_customer(contract, user=customer, reason="передумал")
    deadline = _idle_deadlines(contract).get()
    assert deadline.outcome == "execution_finished"


def test_pending_start_contract_records_activity_without_deadline(customer, contractor):
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    assert contract.execution_status == _EXEC.PENDING_START
    at = timezone.now() + timedelta(days=1)
    event = _contract_event(contract, topic="message.created", actor_user=customer, at=at)
    handlers.handle_contract_activity(event)
    contract.refresh_from_db()
    assert contract.last_activity_at == at
    assert not _idle_deadlines(contract).exists()


def test_draft_negotiation_moves_mark_but_has_no_idle_deadline(customer, contractor):
    from apps.contracts.tests._signing_helpers import make_under_review_contract

    contract = make_under_review_contract(customer=customer, contractor=contractor)
    relay.deliver_due_events()
    contract.refresh_from_db()
    sent = OutboxEvent.objects.get(topic="negotiation.sent")
    assert contract.last_activity_at == sent.occurred_at
    assert not _idle_deadlines(contract).exists()


# --- 5. API ----------------------------------------------------------------


def test_contract_detail_exposes_last_activity_and_idle_deadline(in_progress, customer):
    contract, _ = in_progress
    client = APIClient()
    client.force_authenticate(user=customer)
    response = client.get(f"/v1/contracts/{contract.id}")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["last_activity_at"] is not None
    assert body["idle_deadline_at"] is not None
    assert body["idle_deadline_at"].startswith(
        _active_idle(contract).deadline_at.strftime("%Y-%m-%dT%H:%M:%S")
    )
