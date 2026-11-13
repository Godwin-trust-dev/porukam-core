from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.deadlines import services as deadline_services
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from apps.notifications import services, tasks
from apps.notifications.models import Notification, ReminderPointConfig
from common.models import TaskHeartbeat

pytestmark = pytest.mark.django_db


def _user(suffix: str) -> User:
    # country_code="RU" (ГВ.5, docs/tasks/global-wave.md, ADR-075) — этот
    # пользователь с телефоном тестирует SMS-фоллбек (ADR-057), а SMS —
    # RU-канал: без явного контура резолвер ушёл бы в GLOBAL, где
    # sms_channel_enabled=False, и фоллбек не сработал бы вовсе.
    return User.objects.create(
        trust_id=f"trust-notif-task-{suffix}", phone=f"+7999091{suffix}", country_code="RU"
    )


@pytest.fixture
def kind_config() -> DeadlineKindConfig:
    return DeadlineKindConfig.objects.create(
        kind="reminder_sweep_test", duration=timedelta(hours=100)
    )


def _anchored_deadline(kind_config, *, anchor_at) -> DomainDeadline:
    return deadline_services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=anchor_at,
    )


def test_sweep_fires_due_reminder_and_marks_it(kind_config):
    ReminderPointConfig.objects.create(
        kind=kind_config.kind, template="milestone_acceptance_reminder", points=[0.5]
    )
    recipient = _user("01")
    # anchor_at достаточно давно, чтобы точка 0.5 уже была в прошлом.
    deadline = _anchored_deadline(kind_config, anchor_at=timezone.now() - timedelta(hours=90))
    schedule = services.schedule_reminder_series(deadline, recipient=recipient)[0]
    assert schedule.fired_at is None

    fired = tasks.sweep_reminder_schedules()

    schedule.refresh_from_db()
    assert fired == 1
    assert schedule.fired_at is not None
    assert schedule.notification is not None
    assert Notification.objects.filter(pk=schedule.notification_id).exists()


def test_sweep_skips_reminder_not_yet_due(kind_config):
    ReminderPointConfig.objects.create(
        kind=kind_config.kind, template="milestone_acceptance_reminder", points=[0.99]
    )
    recipient = _user("02")
    deadline = _anchored_deadline(kind_config, anchor_at=timezone.now())
    schedule = services.schedule_reminder_series(deadline, recipient=recipient)[0]

    fired = tasks.sweep_reminder_schedules()

    schedule.refresh_from_db()
    assert fired == 0
    assert schedule.fired_at is None


def test_sweep_skips_reminder_of_already_fired_deadline(kind_config):
    ReminderPointConfig.objects.create(
        kind=kind_config.kind, template="milestone_acceptance_reminder", points=[0.5]
    )
    recipient = _user("03")
    deadline = _anchored_deadline(kind_config, anchor_at=timezone.now() - timedelta(hours=90))
    schedule = services.schedule_reminder_series(deadline, recipient=recipient)[0]
    deadline.fired_at = timezone.now()
    deadline.outcome = "timed_out"
    deadline.save(update_fields=["fired_at", "outcome"])

    fired = tasks.sweep_reminder_schedules()

    schedule.refresh_from_db()
    assert fired == 0
    assert schedule.fired_at is None


def test_sweep_records_heartbeat_even_without_due_reminders():
    tasks.sweep_reminder_schedules()

    assert TaskHeartbeat.objects.filter(name="notifications_reminder_sweep").exists()


def test_final_reminder_sends_fallback_sms_when_push_not_delivered(kind_config):
    ReminderPointConfig.objects.create(
        kind=kind_config.kind, template="milestone_acceptance_reminder", points=[0.5]
    )
    recipient = _user("04")  # без зарегистрированных устройств -> push не доставлен
    deadline = _anchored_deadline(kind_config, anchor_at=timezone.now() - timedelta(hours=90))
    schedule = services.schedule_reminder_series(deadline, recipient=recipient)[0]
    assert schedule.is_final is True

    tasks.sweep_reminder_schedules()

    schedule.refresh_from_db()
    notification = Notification.objects.get(pk=schedule.notification_id)
    assert notification.sms_sent_at is not None
    assert notification.push_sent_at is None


def test_sweep_skips_reminders_of_paused_deadline(kind_config):
    """Дедлайн снят паузой доменным действием (ADR-133 доп. 26.08: заказчик
    подтвердил/возразил по претензии) — свип дедлайнов его не тронет, и
    напоминать о нём не о чем. Снятие паузы возвращает серию к жизни."""
    ReminderPointConfig.objects.create(
        kind=kind_config.kind, template="milestone_acceptance_reminder", points=[0.5]
    )
    recipient = _user("07")
    deadline = _anchored_deadline(kind_config, anchor_at=timezone.now() - timedelta(hours=90))
    schedule = services.schedule_reminder_series(deadline, recipient=recipient)[0]
    deadline_services.pause_deadline(deadline, reason="test")

    assert tasks.sweep_reminder_schedules() == 0
    schedule.refresh_from_db()
    assert schedule.fired_at is None

    deadline_services.resume_deadline(deadline)
    assert tasks.sweep_reminder_schedules() == 1
