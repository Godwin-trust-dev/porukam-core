"""Отметки живости периодических Celery-задач (docs/tasks/fundament-2.md
ЭФ.6 п.2/3; common.models.TaskHeartbeat). Каждая sweep-подобная задача
вызывает `beat(name)` в конце КАЖДОГО прогона — common.metrics.
HeartbeatCollector экспортирует `now() - last_run_at` как метрику
(porukam_task_heartbeat_age_seconds); алёрт "sweep не работает"
(docs/tasks/fundament-2.md ЭФ.6 приёмка) стоит на её росте, не на самом
факте отсутствия просроченных строк — иначе простой (нет работы) и
остановленный beat неотличимы."""

from __future__ import annotations

from django.utils import timezone

from .models import TaskHeartbeat


def beat(name: str) -> None:
    TaskHeartbeat.objects.update_or_create(name=name, defaults={"last_run_at": timezone.now()})
