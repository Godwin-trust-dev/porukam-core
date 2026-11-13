"""Use cases apps.messaging (ADR-112). Общение с другими контекстами — только
через фасады: apps.contracts.selectors (стороны), apps.notifications.services
(дублирующие каналы — тот же паттерн, что signature_requested в
apps.contracts.services), common.outbox (событие для будущих подписчиков)."""

from __future__ import annotations

import logging
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.notifications import services as notifications_services
from common import outbox

from . import selectors
from .models import Message

logger = logging.getLogger(__name__)


def _broadcast_message(contract_id: Any, message: Message) -> None:
    """ADR-113: кадр в группу чата (WebSocket) после коммита. Деградация
    молча в warning: чат живёт и без layer — поллинг фронта остаётся."""
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer

        layer = get_channel_layer()
        if layer is None:
            return
        async_to_sync(layer.group_send)(
            f"chat_{contract_id}",
            {
                "type": "chat.message",
                "contract_id": str(contract_id),
                "message": {
                    "id": str(message.id),
                    "sender_profile_id": str(message.sender_profile_id),
                    "body": message.body,
                    "created_at": message.created_at.isoformat(),
                    "read_at": None,
                },
            },
        )
    except Exception:  # noqa: BLE001 — realtime не должен ронять отправку
        logger.warning("messaging: не удалось разослать кадр чата", exc_info=True)


class EmptyMessageError(ValueError):
    """Пустое (или из одних пробелов) сообщение не отправляется."""


@transaction.atomic
def send_message(contract: Any, *, user: User, body: str) -> Message:
    """POST /contracts/{id}/messages. Append-only — правок и удалений нет
    (доказательная база, ADR-112 §3).

    Уведомление контрагенту — напрямую (place_notification), НЕ через
    outbox-подписчика: тот адресует actor.user_id, то есть отправителя.
    Анти-шторм (§5): пока у контрагента уже висят непрочитанные от меня,
    новое уведомление не создаётся — «звонок в дверь» один на серию."""
    text = body.strip()
    if not text:
        raise EmptyMessageError("пустое сообщение")
    owned = contracts_selectors.user_owned_profile_ids(user)
    mine = next(p for p in contract.parties.all() if p.profile_id in owned)
    already_unread = selectors.has_unread_from_sender(contract, sender_profile_ids=owned)

    message = Message.objects.create(
        contract=contract, sender_profile_id=mine.profile_id, body=text
    )
    transaction.on_commit(lambda: _broadcast_message(contract.id, message))
    outbox.publish(
        "message.created",
        subject={"type": "contract", "id": str(contract.id)},
        payload={"message_id": str(message.id)},
        actor={"user_id": str(user.id)},
    )

    if not already_unread:
        other = contracts_selectors.resolve_counterparty(contract, user)
        recipient = contracts_selectors.party_user(other)
        if recipient is not None:
            notifications_services.place_notification(
                recipient=recipient,
                template="message.received",
                payload={"contract_id": str(contract.id), "message_id": str(message.id)},
                legal_significance=False,
                subject_type="contract",
                subject_id=str(contract.id),
            )
    return message


def mark_read(contract: Any, *, user: User) -> int:
    """POST /contracts/{id}/messages/read — все чужие сообщения переписки
    становятся прочитанными (открытие треда). Идемпотентно."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    return (
        Message.objects.filter(contract=contract, read_at__isnull=True)
        .exclude(sender_profile_id__in=owned)
        .update(read_at=timezone.now())
    )
