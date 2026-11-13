"""Тестовый обработчик topic=domain_deadline.fired (docs/tasks/fundament.md
ЭФ.2: "обработчики появятся в этапе 4 — сейчас тестовый обработчик"). Только
логирует срабатывание — реальные реакции (авто-приёмка, авто-закрытие спора)
подключатся в apps.milestones/apps.disputes на этапе 4 через тот же
реестр OUTBOX_SUBSCRIBERS."""

from __future__ import annotations

import logging

from common.models import OutboxEvent

logger = logging.getLogger(__name__)


def log_fired_deadline(event: OutboxEvent) -> None:
    logger.info(
        "deadlines sweep: сработал дедлайн kind=%s subject=%s event_id=%s",
        event.payload.get("kind"),
        event.subject,
        event.event_id,
    )
