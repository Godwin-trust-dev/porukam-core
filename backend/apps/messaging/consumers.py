"""WebSocket-консьюмер чата (ADR-113): мгновенная доставка сообщений поверх
поллинга (тот остаётся страховкой — при недоступном WS чат работает как
раньше, просто медленнее).

Протокол (JSON-кадры, инициатива клиента):
  → {"type": "auth", "token": "<access JWT>"}        ← {"type": "auth_ok"}
  → {"type": "subscribe", "contract_id": "<uuid>"}   ← {"type": "subscribed", ...}
  ← {"type": "message", "contract_id": ..., "message": {...}}  (из группы)

Токен — ПЕРВЫМ КАДРОМ, не в query string (иначе access-JWT оседал бы в
логах nginx/Cloudflare). Не сторона договора — {"type":"error",
code:"not_found"}: существование договора не раскрываем (та же семантика,
что 404 HTTP-слоя). Группа — `chat_{contract_id}`; рассылает
services.send_message через channel layer (Redis).
"""

from __future__ import annotations

from typing import Any

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.tokens import AccessToken

from apps.accounts.models import User

from . import selectors


class ChatConsumer(AsyncJsonWebsocketConsumer):  # type: ignore[misc]  # channels без стабов
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.user: User | None = None
        self.groups_joined: set[str] = set()

    async def connect(self) -> None:
        await self.accept()

    async def disconnect(self, code: int) -> None:
        for group in self.groups_joined:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def receive_json(self, content: dict[str, Any], **kwargs: Any) -> None:
        kind = content.get("type")
        if kind == "auth":
            await self._auth(str(content.get("token") or ""))
        elif kind == "subscribe":
            await self._subscribe(str(content.get("contract_id") or ""))
        else:
            await self.send_json({"type": "error", "code": "unknown_type"})

    async def _auth(self, token: str) -> None:
        try:
            payload = AccessToken(token)  # type: ignore[arg-type]  # стабы simplejwt уже Token|None
            user = await database_sync_to_async(User.objects.get)(pk=payload["user_id"])
        except (InvalidToken, TokenError, KeyError, User.DoesNotExist):
            await self.send_json({"type": "error", "code": "invalid_token"})
            await self.close(code=4401)
            return
        self.user = user
        await self.send_json({"type": "auth_ok"})

    async def _subscribe(self, contract_id: str) -> None:
        if self.user is None:
            await self.send_json({"type": "error", "code": "auth_required"})
            return
        try:
            await database_sync_to_async(selectors.get_contract_for_party_or_404)(
                contract_id, user=self.user
            )
        except (Http404, ValueError, DjangoValidationError):  # не-UUID / чужой / нет
            await self.send_json({"type": "error", "code": "not_found"})
            return
        group = f"chat_{contract_id}"
        await self.channel_layer.group_add(group, self.channel_name)
        self.groups_joined.add(group)
        await self.send_json({"type": "subscribed", "contract_id": contract_id})

    async def chat_message(self, event: dict[str, Any]) -> None:
        """Кадр из группы (services._broadcast_message) → клиенту."""
        await self.send_json(
            {"type": "message", "contract_id": event["contract_id"], "message": event["message"]}
        )
