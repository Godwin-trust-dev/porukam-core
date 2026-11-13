"""Relay transactional outbox (tech-spec.md §2.6, §6.4; docs/tasks/fundament.md
ЭФ.1; docs/adr/ADR-064-outbox-relay.md).

Доставка — at-least-once на уровне СОБЫТИЯ: если хоть один подписчик темы
падает, событие остаётся неопубликованным (published_at NULL) и на следующем
sweep'е доставляется ЗАНОВО ВСЕМ подписчикам темы, включая тех, что уже
отработали успешно в прошлый раз. Поэтому каждый подписчик обязан быть
идемпотентным по event_id (CLAUDE.md/fundament.md: "идемпотентность
подписчиков — event_id — ключ дедупликации") — это ответственность
подписчика, не реле.

Реестр подписок — данные, не код: settings.OUTBOX_SUBSCRIBERS,
topic -> [dotted.path.to.handler, ...]. handler(event: OutboxEvent) -> None;
исключение = сбой доставки этому подписчику (событие уйдёт на ретрай).

Ключ "*" (docs/adr/ADR-065-*.md, ЭФ.3) — глобальные подписчики, вызываемые
для ЛЮБОГО топика в дополнение к точечным: Audit Vault пишет все доменные
события (принцип §37a), а не по реестру конкретных топиков на приложение.
"""

from __future__ import annotations

import logging
import random
from datetime import timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone
from django.utils.module_loading import import_string

from .models import OutboxEvent

logger = logging.getLogger(__name__)

_DEFAULT_BATCH_SIZE = 100
_DEFAULT_RETRY_BASE_SECONDS = 5
_DEFAULT_RETRY_MAX_SECONDS = 300
_DEFAULT_RETRY_JITTER_SECONDS = 5


def _subscribers_for(topic: str) -> list[str]:
    registry: dict[str, list[str]] = getattr(settings, "OUTBOX_SUBSCRIBERS", {})
    return registry.get("*", []) + registry.get(topic, [])


def _retry_delay(attempt: int) -> timedelta:
    base = getattr(settings, "OUTBOX_RELAY_RETRY_BASE_SECONDS", _DEFAULT_RETRY_BASE_SECONDS)
    cap = getattr(settings, "OUTBOX_RELAY_RETRY_MAX_SECONDS", _DEFAULT_RETRY_MAX_SECONDS)
    jitter = getattr(settings, "OUTBOX_RELAY_RETRY_JITTER_SECONDS", _DEFAULT_RETRY_JITTER_SECONDS)
    backoff = min(base * (2 ** (attempt - 1)), cap)
    return timedelta(seconds=backoff + random.uniform(0, jitter))  # noqa: S311 — не крипто


def deliver_due_events(*, batch_size: int | None = None) -> int:
    """Выбирает неопубликованные события, готовые к (пере)доставке, и
    доставляет их подписчикам. Возвращает число событий, помеченных
    published_at на этом проходе."""
    now = timezone.now()
    limit = batch_size or getattr(settings, "OUTBOX_RELAY_BATCH_SIZE", _DEFAULT_BATCH_SIZE)
    due = (
        OutboxEvent.objects.filter(published_at__isnull=True)
        .filter(Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now))
        .order_by("created_at")[:limit]
    )

    delivered = 0
    for event in due:
        failed = False
        for dotted_path in _subscribers_for(event.topic):
            handler = import_string(dotted_path)
            try:
                handler(event)
            except Exception:
                failed = True
                logger.exception(
                    "relay: подписчик %s не принял событие %s (%s)",
                    dotted_path,
                    event.event_id,
                    event.topic,
                )
        if failed:
            event.delivery_attempts += 1
            event.next_attempt_at = now + _retry_delay(event.delivery_attempts)
            event.save(update_fields=["delivery_attempts", "next_attempt_at"])
        else:
            event.published_at = now
            event.save(update_fields=["published_at"])
            delivered += 1
    return delivered
