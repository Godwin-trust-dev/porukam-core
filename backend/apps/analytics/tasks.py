"""Периодические задачи аналитики (CELERY_BEAT_SCHEDULE, config/settings/base.py).

Это НЕ доменные дедлайны: те не откладываются в Celery, а свипятся из БД
каждую минуту (CLAUDE.md). Пересчёт витрин — обычная периодика раз в час
(docs/tasks/marketing-metrics.md §8.3).
"""

from __future__ import annotations

import logging

from celery import shared_task

from common import heartbeat

from . import services

logger = logging.getLogger(__name__)


@shared_task  # type: ignore[untyped-decorator]  # celery.* без типов (ignore_missing_imports)
def refresh_marts() -> None:
    """Пересчёт всех витрин. Heartbeat пишется на КАЖДЫЙ прогон, независимо
    от результата: иначе остановленный beat и «пересчитывать было нечего»
    выглядели бы одинаково, и алёрт было бы нечем отличить (common.heartbeat)."""
    results = services.refresh_marts()
    heartbeat.beat("analytics_marts_refresh")
    failed = [r.mart for r in results if not r.ok]
    if failed:
        logger.error("analytics: витрины не пересчитались: %s", ", ".join(failed))


@shared_task  # type: ignore[untyped-decorator]
def purge_constructor_step_events() -> None:
    """Хранение поведенческого слоя — 90 дней (§8.1). Это не уборка «когда
    дойдут руки», а условие, на котором слой вообще заведён."""
    deleted = services.purge_constructor_step_events()
    heartbeat.beat("analytics_constructor_purge")
    if deleted:
        logger.info("analytics: удалено событий конструктора: %s", deleted)


@shared_task  # type: ignore[untyped-decorator]
def purge_install_events() -> None:
    """Хранение воронки установки — 90 дней (ADR-171). У этих событий есть
    `user_id`, поэтому срок здесь не формальность: слой заведён на условии,
    что он не превращается в накопительную историю про людей."""
    deleted = services.purge_install_events()
    heartbeat.beat("analytics_install_purge")
    if deleted:
        logger.info("analytics: удалено событий установки: %s", deleted)


@shared_task  # type: ignore[untyped-decorator]
def purge_catalog_search_events() -> None:
    """Хранение слоя каталожного поиска — 90 дней (ADR-186). Событие само по
    себе безлично, но слой существует на том же условии, что и остальные
    два: не копится вечно."""
    deleted = services.purge_catalog_search_events()
    heartbeat.beat("analytics_catalog_search_purge")
    if deleted:
        logger.info("analytics: удалено событий каталожного поиска: %s", deleted)
