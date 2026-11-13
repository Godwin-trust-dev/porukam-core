"""Фоновая сверка директора (domain-model.md §5, scheduled_registry_check):
контроль над юрлицом мог смениться в реестре, а старая SigningAuthority
осталась — периодическая (не sweep-каждую-минуту, это не доменный дедлайн
из CLAUDE.md) проверка по расписанию Celery beat (CELERY_BEAT_SCHEDULE,
config/settings/base.py)."""

from __future__ import annotations

from celery import shared_task

from . import services
from .models import BusinessEntity
from .providers import FakeEntityRegistryProvider

_registry_provider = FakeEntityRegistryProvider()


@shared_task  # type: ignore[untyped-decorator]  # celery.* без типов (ignore_missing_imports)
def reconcile_ownership_epochs() -> None:
    entities = BusinessEntity.objects.filter(claim_status=BusinessEntity.ClaimStatus.CLAIMED)
    for entity in entities:
        services.reconcile_ownership_epoch(entity, provider=_registry_provider)
