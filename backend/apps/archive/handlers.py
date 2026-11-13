"""Подписчики apps.archive (settings.OUTBOX_SUBSCRIBERS, ADR-139):

- `contract.completed` / `contract.terminated` / `contract.auto_closed`
  (ADR-138, строка топика) — окончание сделки -> автоэкспорт ОБЕИМ сторонам
  (ADR-137 треб. 1). `contract.closed` (после гарантии) — фолбэк: если
  автоэкспорта ещё не было (сделка завершилась до этой ветки) — тоже.
- `evidence.shredded` -> `files.zip` экспортов договора удаляется, пакет
  остаётся; `evidence.archived` — состояние в манифесте читается на лету,
  реакции не требует.

Идемпотентны (ADR-064): один автоэкспорт на договор, shred — по files_state."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from apps.contracts import selectors as contracts_selectors
from common.models import OutboxEvent

from . import services


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


def handle_contract_ended(event: OutboxEvent) -> None:
    contract_id = _contract_id(event)
    if contract_id is None:
        return
    contract = contracts_selectors.get_contract(contract_id)
    if contract is None:
        return
    services.request_auto_export(contract)


def handle_evidence_shredded(event: OutboxEvent) -> None:
    contract_id = _contract_id(event)
    if contract_id is None:
        return
    services.shred_export_files(contract_id)
