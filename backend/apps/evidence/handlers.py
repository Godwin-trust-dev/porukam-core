"""Подписчики apps.evidence (settings.OUTBOX_SUBSCRIBERS) — RetentionTimer
ADR-036 через outbox, не вызовами из чужих сервисов (ADR-136 §8):

- `contract.completed` / `contract.terminated` / `contract.auto_closed`
  (ADR-138: сделка без движения; `contract.closed` там не публикуется) —
  окончание сделки (ADR-137: срок хранения платформы НЕ привязан к гарантии
  сторон, «платформа — свидетель, не поручитель») -> старт таймера;
  `contract.closed` (после гарантии) — фолбэк, при живом таймере NOOP.
- `dispute.opened` -> пауза; `dispute.resolved` -> возобновление, но только
  если по договору не осталось других открытых разногласий
  (`apps.disputes.selectors.has_open_disputes`).
- `domain_deadline.fired` с `kind=evidence_*` -> уведомление за 10 дней /
  архив / crypto-shredding.

Все подписчики идемпотентны по состоянию (ADR-064, at-least-once)."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from django.utils.dateparse import parse_datetime

from apps.contracts.models import Contract
from apps.disputes import selectors as disputes_selectors
from common.models import OutboxEvent

from . import services
from .models import RetentionTimer


def _contract_id(event: OutboxEvent) -> UUID | None:
    subject: dict[str, Any] = event.subject or {}
    raw = subject.get("contract_id") or (
        subject.get("id") if subject.get("type") == "contract" else None
    )
    raw = raw or (event.payload or {}).get("contract_id")
    if not raw:
        return None
    try:
        return UUID(str(raw))
    except ValueError:
        return None


def _timer_for(event: OutboxEvent) -> RetentionTimer | None:
    contract_id = _contract_id(event)
    if contract_id is None:
        return None
    return RetentionTimer.objects.filter(contract_id=contract_id).select_related("contract").first()


def handle_contract_ended(event: OutboxEvent) -> None:
    subject = event.subject or {}
    if subject.get("type") != "contract" or not subject.get("id"):
        return
    contract = Contract.objects.filter(pk=subject["id"]).first()
    if contract is None:
        return
    occurred_raw = (event.payload or {}).get("occurred_at")
    anchored_at: datetime | None = parse_datetime(str(occurred_raw)) if occurred_raw else None
    services.start_retention_timer(contract, anchored_at=anchored_at or event.occurred_at)


def handle_dispute_opened(event: OutboxEvent) -> None:
    timer = _timer_for(event)
    if timer is None:
        return
    dispute_id = (event.subject or {}).get("id") or ""
    services.pause_retention_timer(timer, reason=f"dispute:{dispute_id}")


def handle_dispute_resolved(event: OutboxEvent) -> None:
    timer = _timer_for(event)
    if timer is None or timer.paused_at is None:
        return
    if disputes_selectors.has_open_disputes(timer.contract_id):
        return
    services.resume_retention_timer(timer)


def handle_deadline_fired(event: OutboxEvent) -> None:
    payload = event.payload or {}
    kind = str(payload.get("kind") or "")
    if kind not in services.RETENTION_KINDS:
        return
    timer = _timer_for(event)
    if timer is None:
        return
    deadline_id = str(payload.get("deadline_id") or "")
    # Сверка id: у договора может быть и другой дедлайн той же категории
    # (например, от старого таймера) — реагируем только на свои.
    if kind == services.RETENTION_NOTICE_KIND and deadline_id == str(timer.notice_deadline_id):
        services.notify_retention_expiring(timer)
    elif kind == services.HOT_RETENTION_KIND and deadline_id == str(timer.hot_deadline_id):
        services.archive_contract_evidence(timer)
    elif kind == services.ARCHIVE_RETENTION_KIND and deadline_id == str(timer.archive_deadline_id):
        services.shred_contract_evidence(timer)
