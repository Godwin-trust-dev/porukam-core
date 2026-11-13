"""Celery-задача Audit Vault (CELERY_BEAT_SCHEDULE["audit-vault-daily-checkpoint"],
раз в сутки). TSA — по settings.AUDIT_VAULT_TSA_PROVIDER (ADR-135: в проде
`rfc3161` — четыре публичных TSA с кворумом; `fake` — dev/test); объектное
хранилище — настоящий MinIO/S3 (S3CheckpointObjectStore), не фейк:
WORM-выгрузка — часть требования ЭФ.3."""

from __future__ import annotations

from celery import shared_task

from common import heartbeat

from . import chain_health, checkpoint
from .providers import default_timestamp_authority
from .storage import S3CheckpointObjectStore


@shared_task  # type: ignore[untyped-decorator]
def daily_checkpoint() -> int | None:
    result = checkpoint.compute_daily_checkpoint(
        provider=default_timestamp_authority(), store=S3CheckpointObjectStore()
    )
    heartbeat.beat("audit_vault_daily_checkpoint")
    return result.seq_to if result is not None else None


@shared_task  # type: ignore[untyped-decorator]
def export_chain_verification() -> bool:
    """docs/tasks/fundament-2.md ЭФ.6 п.3: периодический verify_chain() +
    сохранение результата (ChainVerificationRun) под алёрт "разрыв цепочки
    Vault" (services/audit_vault/metrics.py читает последнюю строку)."""
    run = chain_health.record_verification_run()
    heartbeat.beat("audit_vault_chain_verification")
    return run.ok
