"""Sweep серии напоминаний (domain-model.md §17; docs/tasks/fundament.md
ЭФ.4). Celery beat каждую минуту (config/settings/base.py CELERY_BEAT_SCHEDULE)
— как и apps.deadlines.tasks.sweep_domain_deadlines, это СТРОКИ В БД
(ReminderSchedule), не отложенные задачи (CLAUDE.md): отложенная задача на
неделю вперёд теряется при сбое брокера, строка в БД — нет."""

from __future__ import annotations

from datetime import datetime

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from common import heartbeat

from . import services
from .models import Notification, ReminderSchedule


def _anchoring_contract_id(schedule: ReminderSchedule) -> str | None:
    """Договор напоминания — тот же, что у уведомления, которым дедлайн
    заякорен (`Notification.related_deadline`): у `DomainDeadline` своего
    contract_id нет, а по субъекту `place_notification` умеет добирать
    договор только для `milestone`. Без этого напоминание по субъекту
    `warranty_claim` (ADR-133, доп. 26.08) осталось бы без `{contract_title}`
    и без якоря навигации ленты."""
    contract_id = (
        Notification.objects.filter(related_deadline=schedule.deadline, contract_id__isnull=False)
        .order_by("placed_in_cabinet_at")
        .values_list("contract_id", flat=True)
        .first()
    )
    return str(contract_id) if contract_id else None


def _days_left(schedule: ReminderSchedule, *, now: datetime) -> int:
    """Целых суток до `deadline_at` на момент отправки напоминания — для
    текстов вида «через {days_left} дн. договор будет закрыт» (ADR-138:
    предупреждение за две недели). Отрицательного не бывает: напоминание
    по уже истёкшему дедлайну sweep не отбирает (deadline.fired_at)."""
    deadline_at = schedule.deadline.deadline_at
    if deadline_at is None:
        return 0
    return max(0, (deadline_at - now).days)


@transaction.atomic
def _fire(schedule: ReminderSchedule) -> None:
    now = timezone.now()
    notification = services.place_notification(
        recipient=schedule.recipient,
        template=schedule.template,
        payload={
            "deadline_id": str(schedule.deadline_id),
            "point": schedule.point,
            "days_left": _days_left(schedule, now=now),
        },
        legal_significance=True,
        subject_type=schedule.deadline.subject_type,
        subject_id=str(schedule.deadline.subject_id),
        subject_contract_id=_anchoring_contract_id(schedule),
        force_sms=schedule.is_final,
    )
    schedule.fired_at = now
    schedule.notification = notification
    schedule.save(update_fields=["fired_at", "notification"])


@shared_task  # type: ignore[untyped-decorator]  # celery.* без типов (ignore_missing_imports)
def sweep_reminder_schedules() -> int:
    """Выбирает due (fire_at <= now, fired_at IS NULL) напоминания
    НЕсработавших и НЕприостановленных дедлайнов (deadline.fired_at IS NULL —
    дедлайн уже закрыт; deadline.paused — окно снято доменным действием,
    например подтверждением/возражением по гарантийной претензии, ADR-133
    доп. 26.08: свип дедлайнов такой дедлайн не тронет, значит и напоминать о
    нём не о чем) и отправляет их. Возвращает число отправленных на этом
    проходе."""
    now = timezone.now()
    due = ReminderSchedule.objects.select_related("deadline", "recipient").filter(
        fired_at__isnull=True,
        fire_at__lte=now,
        deadline__fired_at__isnull=True,
        deadline__paused=False,
    )
    fired = 0
    for schedule in due:
        _fire(schedule)
        fired += 1
    heartbeat.beat("notifications_reminder_sweep")
    return fired


@shared_task  # type: ignore[untyped-decorator]  # celery.* без типов (ignore_missing_imports)
def sweep_materials_change_digests() -> int:
    """ADR-156: закрывает созревшие окна схлопывания правок материалов и
    размещает по одной карточке на окно. Тот же приём, что у свипа
    напоминаний выше: окно — СТРОКИ В БД (PendingMaterialsChange), а не
    отложенная на N минут задача (CLAUDE.md), и heartbeat отбивается на
    КАЖДОМ прогоне, даже пустом — иначе «нет правок» и «beat остановлен»
    неотличимы."""
    placed = services.flush_materials_change_digests()
    heartbeat.beat("notifications_materials_change_sweep")
    return placed
