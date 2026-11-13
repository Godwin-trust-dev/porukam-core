from datetime import timedelta
from uuid import uuid4

import pytest
from django.test import override_settings
from django.utils import timezone

from apps.deadlines import services, tasks
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from common.models import OutboxEvent, TaskHeartbeat

pytestmark = pytest.mark.django_db


@pytest.fixture
def kind_config() -> DeadlineKindConfig:
    return DeadlineKindConfig.objects.create(kind="test_kind", duration=timedelta(hours=1))


def _overdue(kind_config, **overrides) -> DomainDeadline:
    return services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now() - timedelta(hours=2),
        **overrides,
    )


def test_sweep_fires_overdue_active_deadline_and_publishes_event(kind_config):
    """fundament.md ЭФ.2: «sweep срабатывает не позже +1 цикла»."""
    deadline = _overdue(kind_config)

    fired = tasks.sweep_domain_deadlines()

    deadline.refresh_from_db()
    assert fired == 1
    assert deadline.fired_at is not None
    assert deadline.outcome == "timed_out"

    event = OutboxEvent.objects.get(
        topic="domain_deadline.fired", subject__id=str(deadline.subject_id)
    )
    assert event.payload["deadline_id"] == str(deadline.id)
    assert event.payload["kind"] == kind_config.kind


def test_sweep_skips_paused_deadline(kind_config):
    """fundament.md ЭФ.2: «пауза останавливает»."""
    deadline = _overdue(kind_config)
    services.pause_deadline(deadline, reason="ожидание материалов")

    fired = tasks.sweep_domain_deadlines()

    deadline.refresh_from_db()
    assert fired == 0
    assert deadline.fired_at is None


def test_sweep_skips_unanchored_deadline(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.CABINET_PLACEMENT,
    )

    fired = tasks.sweep_domain_deadlines()

    deadline.refresh_from_db()
    assert fired == 0
    assert deadline.fired_at is None


def test_sweep_skips_deadline_in_the_future(kind_config):
    deadline = services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=timezone.now() + timedelta(hours=1),
    )

    fired = tasks.sweep_domain_deadlines()

    deadline.refresh_from_db()
    assert fired == 0
    assert deadline.fired_at is None


_seen_events: list[str] = []


def _collect(event: OutboxEvent) -> None:
    _seen_events.append(str(event.event_id))


@override_settings(
    OUTBOX_SUBSCRIBERS={"domain_deadline.fired": ["apps.deadlines.tests.test_tasks._collect"]}
)
def test_fired_event_is_delivered_by_relay_to_registered_handler(kind_config):
    from common import relay

    deadline = _overdue(kind_config)
    tasks.sweep_domain_deadlines()

    event = OutboxEvent.objects.get(
        topic="domain_deadline.fired", subject__id=str(deadline.subject_id)
    )
    delivered = relay.deliver_due_events()

    event.refresh_from_db()
    assert delivered >= 1
    assert event.published_at is not None
    assert str(event.event_id) in _seen_events


def test_sweep_records_heartbeat_even_without_overdue_deadlines():
    """docs/tasks/fundament-2.md ЭФ.6 п.2/3: "лаг sweep, SLO < 60 с" — на
    остановке Celery beat стоит алёрт. common.heartbeat.beat() должен
    отмечаться на КАЖДЫЙ прогон, а не только когда что-то сработало —
    иначе простой (нет просроченных дедлайнов) и остановленный beat
    неотличимы по метрике."""
    tasks.sweep_domain_deadlines()

    assert TaskHeartbeat.objects.filter(name="deadlines_sweep").exists()


def test_dev_log_handler_logs_the_firing(kind_config, caplog):
    """✅ ЭФ.2: «в dev ... через ≤3 минуты в логах sweep — событие срабатывания»."""
    from apps.deadlines.handlers import log_fired_deadline

    deadline = _overdue(kind_config)
    tasks.sweep_domain_deadlines()
    event = OutboxEvent.objects.get(
        topic="domain_deadline.fired", subject__id=str(deadline.subject_id)
    )

    with caplog.at_level("INFO"):
        log_fired_deadline(event)

    assert any(kind_config.kind in message for message in caplog.messages)
