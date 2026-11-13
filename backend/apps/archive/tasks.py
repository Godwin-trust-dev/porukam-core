"""Celery-задача сборки архива (ADR-139, ADR-137 треб. 10: никакой сборки
в запросе — Cloudflare 125 с). Это НЕ доменный дедлайн (те — строки БД +
свип): задача ставится сразу после коммита `request_export` и выполняется
один раз; потеря задачи при сбое брокера видна как `queued` без
`started_at` — повторная постановка `requeue_stale_exports` (beat)."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any
from uuid import UUID

from celery import shared_task
from django.conf import settings
from django.utils import timezone

from . import services
from .models import ArchiveExport

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3)  # type: ignore[untyped-decorator]  # celery.* без типов
def build_archive_export(self: Any, export_id: str) -> str:  # noqa: ANN401
    export = ArchiveExport.objects.select_related("contract").filter(pk=UUID(export_id)).first()
    if export is None:
        return "missing"
    if export.status == ArchiveExport.Status.READY:
        return "already_ready"
    try:
        services.build_export(export)
    except Exception as exc:  # noqa: BLE001 — статус failed + ретрай, не молчаливая потеря
        logger.exception("archive: сборка экспорта %s не удалась", export_id)
        services.mark_failed(export, error=f"{type(exc).__name__}: {exc}")
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc, countdown=settings.ARCHIVE_BUILD_RETRY_SECONDS) from exc
        return "failed"
    return "ready"


@shared_task  # type: ignore[untyped-decorator]
def requeue_stale_exports() -> int:
    """Beat: экспорты, застрявшие в `queued` дольше `ARCHIVE_STALE_QUEUED_MINUTES`
    (задача потеряна брокером до старта), ставятся заново."""
    threshold = timezone.now() - timedelta(minutes=settings.ARCHIVE_STALE_QUEUED_MINUTES)
    stale = ArchiveExport.objects.filter(
        status=ArchiveExport.Status.QUEUED, started_at__isnull=True, created_at__lte=threshold
    )
    count = 0
    for export in stale:
        build_archive_export.delay(str(export.id))
        count += 1
    return count
