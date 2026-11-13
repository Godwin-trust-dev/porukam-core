"""Celery-задачи common/ (ADR-064): relay_sweep гоняется по расписанию
Celery beat (CELERY_BEAT_SCHEDULE, config/settings/base.py) — НЕ путать со
sweep доменных дедлайнов (тот — из БД-строк каждую минуту, CLAUDE.md;
появится в apps.deadlines, ЭФ.2)."""

from __future__ import annotations

from celery import shared_task

from . import heartbeat, relay


@shared_task  # type: ignore[untyped-decorator]  # celery.* без типов (ignore_missing_imports)
def relay_sweep() -> int:
    delivered = relay.deliver_due_events()
    heartbeat.beat("outbox_relay")
    return delivered
