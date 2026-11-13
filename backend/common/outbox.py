"""Публикация доменных событий через transactional outbox (tech-spec.md §6.4).

publish() только создаёт строку в БД — вызывающая сторона обязана делать это
внутри transaction.atomic() вместе с изменением данных, иначе нет гарантии
"событие записано тогда и только тогда, когда записаны данные". Реле,
рассылающее строки outbox подписчикам (Celery/лента/Audit Vault), сюда не
входит — это отдельная задача позже.
"""

from __future__ import annotations

from typing import Any

from django.utils import timezone

from .models import OutboxEvent


def publish(
    topic: str,
    *,
    subject: dict[str, Any],
    payload: dict[str, Any],
    actor: dict[str, Any] | None = None,
) -> OutboxEvent:
    return OutboxEvent.objects.create(
        topic=topic,
        occurred_at=timezone.now(),
        actor=actor or {},
        subject=subject,
        payload=payload,
        schema_version=1,
    )
