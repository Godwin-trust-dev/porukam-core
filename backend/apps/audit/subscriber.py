"""Подписчик Audit Vault на ВСЕ outbox-события (settings.OUTBOX_SUBSCRIBERS["*"],
common/relay.py) — принцип §37a (tech-spec.md §6.4): «одна запись события
порождает (а) ленту объекта, (б) уведомления, (в) запись в Audit Vault».
Идемпотентен по event_id (ADR-064/065): client.append(source_event_id=...)
дедуплицирует, так что повторная доставка того же события реле не создаёт
второй записи в Vault."""

from __future__ import annotations

from typing import Any

from common.models import OutboxEvent

from . import client


def _actor_role(actor: dict[str, Any]) -> str:
    """Событие несёт `actor` из tech-spec.md §6.4 (`user_id`/`profile_id`/
    `on_behalf_of_entity`), но не готовую "роль" в смысле audit_entry.actor_role
    (tech-spec.md §10.3, роли support/compliance/finance/admin — это служебные роли,
    действующий на break-glass/операторских сценариях, ЕЩЁ не реализованных).
    Пока: пустой actor (фоновые/системные события) -> "system", служебное действие
    (когда появится, будет класть явный actor.staff_role) -> эта роль,
    обычное пользовательское действие -> "user"."""
    if not actor:
        return "system"
    staff_role = actor.get("staff_role")
    if staff_role:
        return str(staff_role)
    return "user"


def handle_event(event: OutboxEvent) -> None:
    subject = event.subject or {}
    client.append(
        actor=event.actor,
        actor_role=_actor_role(event.actor),
        action=event.topic,
        target_type=subject.get("type", "unknown"),
        target_id=str(subject.get("id", "")),
        payload=event.payload,
        at=event.occurred_at,
        source_event_id=event.event_id,
    )
