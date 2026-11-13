from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from common.api.exceptions import DomainAPIError

from .. import selectors, services
from .serializers import (
    MessageCreateSerializer,
    MessageSerializer,
    MessagesResponseSerializer,
    ThreadSerializer,
)


def _messages_response(contract: Any, *, user: User) -> Response:
    owned = contracts_selectors.user_owned_profile_ids(user)
    return Response(
        MessagesResponseSerializer(
            {
                "items": list(selectors.list_messages(contract)),
                "unread_count": selectors.unread_count(contract, owned_profile_ids=owned),
            }
        ).data
    )


class ContractMessagesView(APIView):
    """GET/POST /contracts/{id}/messages (ADR-112) — переписка по договору.
    Не сторона — 404 (существование не раскрываем)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: MessagesResponseSerializer})
    def get(self, request: Request, contract_id: UUID) -> Response:
        user = cast(User, request.user)
        contract = selectors.get_contract_for_party_or_404(contract_id, user=user)
        return _messages_response(contract, user=user)

    @extend_schema(request=MessageCreateSerializer, responses={201: MessageSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        user = cast(User, request.user)
        contract = selectors.get_contract_for_party_or_404(contract_id, user=user)
        serializer = MessageCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            message = services.send_message(
                contract, user=user, body=serializer.validated_data["body"]
            )
        except services.EmptyMessageError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="empty_message",
                title="Сообщение не может быть пустым",
            ) from exc
        return Response(MessageSerializer(message).data, status=status.HTTP_201_CREATED)


class ContractMessagesReadView(APIView):
    """POST /contracts/{id}/messages/read — открытие треда, идемпотентно."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: MessagesResponseSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        user = cast(User, request.user)
        contract = selectors.get_contract_for_party_or_404(contract_id, user=user)
        services.mark_read(contract, user=user)
        return _messages_response(contract, user=user)


class ThreadsView(APIView):
    """GET /messages/threads — диалоги пользователя, свежие сверху."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ThreadSerializer(many=True)})
    def get(self, request: Request) -> Response:
        threads = selectors.list_threads(cast(User, request.user))
        return Response(ThreadSerializer(threads, many=True).data)
