from __future__ import annotations

from typing import cast
from uuid import UUID

from django.conf import settings
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from common.api.exceptions import DomainAPIError
from common.i18n import resolve_request_locale

from .. import selectors, services
from .serializers import (
    DeviceTokenRegisterSerializer,
    DeviceTokenSerializer,
    DeviceTokenUnregisterSerializer,
    NotificationFeedSerializer,
    NotificationSettingsSerializer,
    NotificationSettingsUpdateSerializer,
    PushConfigSerializer,
    PushSubscribeSerializer,
    PushUnsubscribeSerializer,
)

# Пагинация ленты (решение владельца 05.09): страница по 15, дальше —
# «Показать ещё» по непрозрачному курсору. Параметры описаны один раз и
# висят на всех трёх эндпоинтах ленты.
_FEED_PARAMS = [
    OpenApiParameter(
        "filter",
        str,
        description="all | unread | deals | chats | payments | deadlines | disputes",
    ),
    OpenApiParameter(
        "limit",
        int,
        description=(
            f"Размер страницы, по умолчанию {selectors.FEED_PAGE_SIZE}, "
            f"максимум {selectors.FEED_PAGE_SIZE_MAX}. Вне диапазона — 400."
        ),
    ),
    OpenApiParameter(
        "cursor",
        str,
        description=(
            "Непрозрачный курсор следующей страницы — значение `next_cursor` "
            "предыдущего ответа. Неразбираемый курсор — 400."
        ),
    ),
]
# POST /read и /read-all курсор не принимают — только ?filter=&limit=.
_FEED_FIRST_PAGE_PARAMS = _FEED_PARAMS[:2]


def _feed_query(request: Request) -> tuple[str, int]:
    """?filter=&limit= с валидацией. Невалидное — 400, а не молчаливый дефолт:
    клиент должен узнать, что его лимит проигнорирован."""
    filter_key = request.query_params.get("filter") or "all"
    if filter_key not in selectors.FEED_FILTERS:
        raise ValidationError({"filter": f"один из {sorted(selectors.FEED_FILTERS)}"})
    raw_limit = request.query_params.get("limit")
    if raw_limit is None:
        return filter_key, selectors.FEED_PAGE_SIZE
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        raise ValidationError({"limit": "целое число"}) from None
    if not 1 <= limit <= selectors.FEED_PAGE_SIZE_MAX:
        raise ValidationError({"limit": f"от 1 до {selectors.FEED_PAGE_SIZE_MAX}"})
    return filter_key, limit


def _feed_response(request: Request, *, cursor: str | None = None) -> Response:
    """Все три эндпоинта ленты отвечают одинаково — страницей ленты (DEV-14 §7).
    POST /read и /read-all отдают ПЕРВУЮ страницу с теми же ?filter=&limit=
    (курсор к ним не применяется): после «прочитано» фронту нужны свежие
    счётчики, а не продолжение чужой прокрутки."""
    filter_key, limit = _feed_query(request)
    try:
        feed = selectors.feed_for_recipient(
            cast(User, request.user),
            filter_key=filter_key,
            locale=resolve_request_locale(request),
            limit=limit,
            cursor=cursor,
            request=request,
        )
    except selectors.InvalidFeedCursorError:
        raise ValidationError({"cursor": "курсор не разбирается"}) from None
    return Response(NotificationFeedSerializer(feed).data)


class NotificationListView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(parameters=_FEED_PARAMS, responses={200: NotificationFeedSerializer})
    def get(self, request: Request) -> Response:
        return _feed_response(request, cursor=request.query_params.get("cursor") or None)


class NotificationReadView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(parameters=_FEED_FIRST_PAGE_PARAMS, responses={200: NotificationFeedSerializer})
    def post(self, request: Request, notification_id: UUID) -> Response:
        notification = selectors.get_for_recipient_or_404(
            notification_id, user=cast(User, request.user)
        )
        services.mark_read(notification, user=cast(User, request.user))
        return _feed_response(request)


class NotificationReadAllView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(parameters=_FEED_FIRST_PAGE_PARAMS, responses={200: NotificationFeedSerializer})
    def post(self, request: Request) -> Response:
        services.mark_all_read(cast(User, request.user))
        return _feed_response(request)


class NotificationSettingsView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: NotificationSettingsSerializer})
    def get(self, request: Request) -> Response:
        settings_row = services.get_or_create_settings(cast(User, request.user))
        return Response(NotificationSettingsSerializer(settings_row).data)

    @extend_schema(
        request=NotificationSettingsUpdateSerializer,
        responses={200: NotificationSettingsSerializer},
    )
    def put(self, request: Request) -> Response:
        serializer = NotificationSettingsUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            settings_row = services.update_settings(
                cast(User, request.user),
                # Имена контракта фронта (DEV-14 §7) → поля модели.
                in_app_enabled=data.get("in_app"),
                push_enabled=data.get("push"),
                email_enabled=data.get("email"),
                sms_enabled=data.get("sms"),
                push_permission=data.get("push_permission"),
                groups=data.get("groups"),
            )
        except services.InAppChannelCannotBeDisabledError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="in_app_channel_cannot_be_disabled",
                title="Уведомления в личном кабинете нельзя отключить",
                detail=str(exc),
            ) from exc
        except services.PushPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="push_permission_denied",
                title="Уведомления выключены в настройках устройства",
                detail=str(exc),
            ) from exc
        return Response(NotificationSettingsSerializer(settings_row).data)


class PushConfigView(APIView):
    """GET /push/config (ADR-110) — публичный VAPID-ключ для
    `PushManager.subscribe()`. Приватный ключ не покидает сервер."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: PushConfigSerializer})
    def get(self, request: Request) -> Response:
        data = {"vapid_public_key": settings.WEBPUSH_VAPID_PUBLIC_KEY}
        return Response(PushConfigSerializer(data).data)


class PushSubscriptionView(APIView):
    """POST /push-subscriptions (ADR-110): регистрация Web Push подписки
    браузера. Идемпотентно по endpoint (см. services.subscribe_push)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=PushSubscribeSerializer, responses={201: None})
    def post(self, request: Request) -> Response:
        serializer = PushSubscribeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        services.subscribe_push(
            cast(User, request.user),
            endpoint=data["endpoint"],
            p256dh=data["keys"]["p256dh"],
            auth=data["keys"]["auth"],
            user_agent=request.headers.get("User-Agent", ""),
        )
        return Response(status=status.HTTP_201_CREATED)


class PushUnsubscribeView(APIView):
    """POST /push-subscriptions/unsubscribe (ADR-110). Идемпотентно — 204 и
    для неизвестного endpoint (не раскрываем существование чужих подписок)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=PushUnsubscribeSerializer, responses={204: None})
    def post(self, request: Request) -> Response:
        serializer = PushUnsubscribeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.unsubscribe_push(
            cast(User, request.user), endpoint=serializer.validated_data["endpoint"]
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class DeviceTokenView(APIView):
    """POST /device-tokens (ADR-176): регистрация токена нативного пуш-канала
    (RuStore/FCM/HMS) из мобильной обёртки. Идемпотентно по `token` — обёртка
    шлёт его при каждом запуске (мост TWA — параметр стартового URL), поэтому
    повторная регистрация того же токена отвечает тем же 201 и не создаёт
    дубля. `Idempotency-Key` не нужен: идемпотентность по построению, денег и
    подписей эндпоинт не касается."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=DeviceTokenRegisterSerializer, responses={201: DeviceTokenSerializer})
    def post(self, request: Request) -> Response:
        serializer = DeviceTokenRegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            device_token = services.register_device_token(
                cast(User, request.user),
                provider=data["provider"],
                token=data["token"],
                app_id=data["app_id"],
                platform=data.get("platform") or "android",
                user_agent=request.headers.get("User-Agent", ""),
            )
        except services.EmptyDeviceTokenError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="empty_device_token",
                title="Пустой токен устройства",
                detail=str(exc),
            ) from exc
        except services.UnknownPushProviderError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="unknown_push_provider",
                title="Неизвестный провайдер пушей",
                detail=str(exc),
            ) from exc
        return Response(DeviceTokenSerializer(device_token).data, status=status.HTTP_201_CREATED)


class DeviceTokenUnregisterView(APIView):
    """POST /device-tokens/unregister (ADR-176). Идемпотентно — 204 и для
    неизвестного/чужого токена (существование чужих устройств не раскрываем),
    удаляется только СВОЙ."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=DeviceTokenUnregisterSerializer, responses={204: None})
    def post(self, request: Request) -> Response:
        serializer = DeviceTokenUnregisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.unregister_device_token(
            cast(User, request.user), token=serializer.validated_data["token"]
        )
        return Response(status=status.HTTP_204_NO_CONTENT)
