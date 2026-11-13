"""Sweep доменных дедлайнов (tech-spec.md §2.5, §5.2.10; docs/tasks/fundament.md
ЭФ.2). ЭТО НЕ common.tasks.relay_sweep (тот — инфраструктурная доставка
outbox, Celery beat каждые 5 с) — здесь доменные тайм-ауты, строки БД,
Celery beat КАЖДУЮ МИНУТУ (CLAUDE.md, CELERY_BEAT_SCHEDULE в
config/settings/base.py).

Обработчики срабатывания по конкретным `kind` (авто-приёмка, авто-закрытие
спора, ...) появятся в этапе 4 — сейчас sweep сам публикует событие
`domain_deadline.fired` в outbox с обобщённым outcome; конкретную бизнес-судьбу
доопределит подписчик своего этапа (может переписать `outcome` повторно)."""

from __future__ import annotations

from datetime import datetime

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from common import heartbeat, outbox

from .models import DomainDeadline

_GENERIC_TIMED_OUT_OUTCOME = "timed_out"


@transaction.atomic
def _fire(deadline: DomainDeadline, *, now: datetime) -> None:
    deadline.fired_at = now
    deadline.outcome = _GENERIC_TIMED_OUT_OUTCOME
    deadline.save(update_fields=["fired_at", "outcome"])
    outbox.publish(
        "domain_deadline.fired",
        subject={"type": deadline.subject_type, "id": str(deadline.subject_id)},
        payload={
            "deadline_id": str(deadline.id),
            "kind": deadline.kind,
            "outcome": deadline.outcome,
        },
        actor={},
    )


@shared_task  # type: ignore[untyped-decorator]  # celery.* без типов (ignore_missing_imports)
def sweep_domain_deadlines() -> int:
    """Выбирает просроченные заякоренные активные дедлайны (deadline_at IS
    NOT NULL, <= now, fired_at IS NULL, paused=false) и переводит их в
    fired_at + событие. Возвращает число сработавших на этом проходе."""
    now = timezone.now()
    due = DomainDeadline.objects.filter(
        fired_at__isnull=True,
        paused=False,
        deadline_at__isnull=False,
        deadline_at__lte=now,
    )
    fired = 0
    for deadline in due:
        _fire(deadline, now=now)
        fired += 1
    # На КАЖДЫЙ прогон, включая "просроченных нет" — иначе простой и
    # остановленный Celery beat неотличимы по метрике (common/heartbeat.py).
    heartbeat.beat("deadlines_sweep")
    return fired
