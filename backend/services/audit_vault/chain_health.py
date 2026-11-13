"""Периодическая проверка цепочки Audit Vault (docs/tasks/fundament-2.md
ЭФ.6 п.3: "разрыв цепочки Vault — экспорт результата verify_chain по
расписанию"). `verify_chain()` пересчитывает хеш каждой записи — дорого при
большой цепочке, поэтому гоняется РЕДКО (CELERY_BEAT_SCHEDULE), не на
каждый /metrics-скрейп; результат сохраняется в ChainVerificationRun,
откуда его читает services/audit_vault/metrics.py."""

from __future__ import annotations

from . import api
from .models import ChainVerificationRun


def record_verification_run() -> ChainVerificationRun:
    result = api.verify_chain()
    return ChainVerificationRun.objects.create(
        ok=result.ok,
        entries_checked=result.entries_checked,
        first_broken_seq=result.first_broken_seq,
    )
