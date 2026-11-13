from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import DeviceToken, Notification, NotificationSettings


class NotificationSerializer(serializers.ModelSerializer[Notification]):
    class Meta:
        model = Notification
        fields = [
            "id",
            "template",
            "payload",
            "legal_significance",
            "placed_in_cabinet_at",
            "content_hash",
            "read_at",
            "delivered_via",
            "related_deadline",
            "created_at",
        ]
        read_only_fields = fields


class NotificationFeedItemSerializer(serializers.Serializer[Any]):
    """Пункт ленты ЛК (DEV-14 §7) — отрезолвленная проекция Notification
    (selectors._feed_item), не сырая модель: type/severity/group — валюта
    фронта (иконка/окраска/вкладки).

    ADR-159 отменил прежнее «шаблон наружу не отдаём»: `type` склеивает
    десятки поводов в один (`negotiation`), и адресно узнать конкретный
    (напр. `contract.materials_changed`) по нему нельзя. `template_code` —
    сам код шаблона строки Notification, стабильный ключ реестра
    `_FEED_TEMPLATE_TYPES`; `type`/`severity`/`group` остаются, фронт волен
    ими и ограничиться."""

    id = serializers.UUIDField()
    type = serializers.CharField()
    # ADR-159 — ключ есть у КАЖДОГО пункта: `template` — обязательный
    # параметр place_notification. `allow_blank` — оборонительно, на строки,
    # заведённые в обход фасада (тогда пункт всё равно не теряем: лента —
    # юрканал, ADR-057, и проекция уже терпит неизвестный шаблон).
    template_code = serializers.CharField(allow_blank=True)
    title = serializers.CharField()
    severity = serializers.CharField()
    created_at = serializers.DateTimeField()
    read = serializers.BooleanField()
    group = serializers.CharField()
    # ADR-098 — опциональны (см. selectors._feed_item): у событий без
    # договора и у уведомлений до ADR-098 этих ключей нет.
    action = serializers.DictField(required=False)
    contract = serializers.DictField(required=False)
    counterparty = serializers.DictField(required=False)
    # Сумма договора {amount: строка Decimal, currency} — отсмотр прода
    # 2026-08-20: selectors клали её в пункт, а сериализатор поля не знал и
    # молча выкидывал — фронт никогда не видел сумму.
    amount = serializers.DictField(required=False)


class NotificationFeedSerializer(serializers.Serializer[Any]):
    """GET /notifications, POST /notifications/{id}/read, /read-all —
    {items, unread_count, groups, next_cursor, total} (DEV-14 §7).

    `items` — ОДНА страница (по умолчанию 15, решение владельца 05.09);
    `unread_count`/`groups` — счётчики вкладок по ВСЕЙ ленте; `total` — длина
    текущей отфильтрованной ленты (фронту — «Показать ещё N»); `next_cursor` —
    непрозрачный курсор следующей страницы, null на последней."""

    items = NotificationFeedItemSerializer(many=True)
    unread_count = serializers.IntegerField()
    groups = serializers.DictField(child=serializers.IntegerField())
    next_cursor = serializers.CharField(allow_null=True)
    total = serializers.IntegerField()


def _mask_email(email: str) -> str:
    """Маскировка адреса для ЛК («go••••n@example.com», как в моке): адрес —
    ПД, страница настроек показывает его только для узнавания «куда шлём»."""
    local, _, domain = email.partition("@")
    if not domain:
        return email
    masked = (local[:1] or "•") + "•••" if len(local) <= 3 else f"{local[:2]}••••{local[-1]}"
    return f"{masked}@{domain}"


class NotificationChannelGroupsSerializer(serializers.Serializer[Any]):
    deals = serializers.BooleanField(required=False)
    chats = serializers.BooleanField(required=False)
    payments = serializers.BooleanField(required=False)
    deadlines = serializers.BooleanField(required=False)
    disputes = serializers.BooleanField(required=False)


class NotificationSettingsSerializer(serializers.Serializer[Any]):
    """GET/PUT-ответ /notification-settings — контракт фронта DEV-14 §7
    (packages/core NotificationSettings; №10 отсмотра 2026-08-18): раньше
    отдавались сырые поля модели ({in_app_enabled, push_enabled, …}), и
    страница настроек падала на settings.groups, а промо-полоса push тихо
    не показывалась. `sms` — сверх фронтового типа (RU-волна), фронт
    игнорирует лишний ключ."""

    in_app = serializers.BooleanField(source="in_app_enabled")
    push = serializers.BooleanField(source="push_enabled")
    push_permission = serializers.CharField()
    email = serializers.BooleanField(source="email_enabled")
    email_address = serializers.SerializerMethodField()
    sms = serializers.BooleanField(source="sms_enabled")
    groups = serializers.SerializerMethodField()

    def get_email_address(self, obj: NotificationSettings) -> str:
        return _mask_email(obj.user.email or "")

    def get_groups(self, obj: NotificationSettings) -> dict[str, bool]:
        return {
            "deals": obj.group_deals,
            "chats": obj.group_chats,
            "payments": obj.group_payments,
            "deadlines": obj.group_deadlines,
            "disputes": obj.group_disputes,
        }


class NotificationSettingsUpdateSerializer(serializers.Serializer[Any]):
    """PUT — имена контракта фронта (push/email/groups/push_permission).
    `in_app` присутствует в схеме и намеренно ПРИНИМАЕТСЯ на входе (а не
    отбрасывается) — так эндпоинт возвращает содержательную доменную ошибку
    (422 InAppChannelCannotBeDisabledError) на попытку его отключить, а не
    молча игнорирует поле. `email_address` не принимается: адрес — проекция
    аккаунта, не настройка."""

    in_app = serializers.BooleanField(required=False)
    push = serializers.BooleanField(required=False)
    email = serializers.BooleanField(required=False)
    sms = serializers.BooleanField(required=False)
    push_permission = serializers.ChoiceField(
        required=False, choices=NotificationSettings.PushPermission.choices
    )
    groups = NotificationChannelGroupsSerializer(required=False)


class PushSubscriptionKeysSerializer(serializers.Serializer[Any]):
    """`PushSubscription.toJSON().keys` браузера (RFC 8291) — base64url."""

    p256dh = serializers.CharField(max_length=255)
    auth = serializers.CharField(max_length=255)


class PushSubscribeSerializer(serializers.Serializer[Any]):
    """POST /push-subscriptions (ADR-110) — тело `PushSubscription.toJSON()`
    браузера без лишних полей (expirationTime не храним — чистка идёт по
    404/410 от push-сервиса при отправке)."""

    endpoint = serializers.URLField(max_length=2000)
    keys = PushSubscriptionKeysSerializer()


class PushUnsubscribeSerializer(serializers.Serializer[Any]):
    endpoint = serializers.URLField(max_length=2000)


class PushConfigSerializer(serializers.Serializer[Any]):
    """GET /push/config — VAPID public key для `PushManager.subscribe()`.
    Пустая строка = Web Push на инсталляции не настроен (фронт молча
    пропускает подписку, тумблер остаётся «разрешение выдано»)."""

    vapid_public_key = serializers.CharField(allow_blank=True)


class DeviceTokenRegisterSerializer(serializers.Serializer[Any]):
    """POST /device-tokens (ADR-176) — токен нативного пуш-провайдера из
    мобильной обёртки. `provider` НЕ ChoiceField: неизвестный провайдер должен
    доехать до services и вернуться доменной ошибкой 422
    `unknown_push_provider`, а не безымянным 400 сериализатора — обёртка
    обновляется через магазин и узнать причину отказа должна однозначно.

    `token` — TextField в модели, здесь потолок 4096: длина токена у трёх
    провайдеров не нормирована, но неограниченное тело принимать незачем.
    `allow_blank` — по той же причине, что и свободный `provider`: пустая
    строка едет в services и возвращается 422 `empty_device_token`."""

    provider = serializers.CharField(max_length=16)
    token = serializers.CharField(max_length=4096, allow_blank=True)
    app_id = serializers.CharField(max_length=128)
    platform = serializers.CharField(max_length=16, required=False, default="android")


class DeviceTokenUnregisterSerializer(serializers.Serializer[Any]):
    """POST /device-tokens/unregister — 204 всегда, поэтому пустая строка тут
    не ошибка, а просто «удалять нечего»."""

    token = serializers.CharField(max_length=4096, allow_blank=True)


class DeviceTokenSerializer(serializers.ModelSerializer[DeviceToken]):
    """Ответ 201 регистрации: подтверждение записи без самого токена — он у
    клиента уже есть, а в логах и ответах ему делать нечего."""

    class Meta:
        model = DeviceToken
        fields = ["id", "provider", "app_id", "platform", "created_at"]
        read_only_fields = fields
