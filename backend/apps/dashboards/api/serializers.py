from __future__ import annotations

from typing import Any

from rest_framework import serializers


class DashboardAttentionItemSerializer(serializers.Serializer[Any]):
    """`id` — составной (`"<kind>:<uuid>"`), не сырой UUID: `kind` различает
    ресурс (`SignatureRequest`/`Milestone`), у которого своё пространство id
    (ADR-090 §2). `action_label`/`route` НЕ отдаются — фронт строит их
    локально по `kind` (i18n остаётся на фронте)."""

    id = serializers.CharField()
    kind = serializers.ChoiceField(choices=["signature", "acceptance", "submission"])
    side = serializers.ChoiceField(choices=["customer", "contractor"])
    contract_id = serializers.UUIDField()
    title = serializers.CharField()
    deadline_at = serializers.DateTimeField(allow_null=True)


class DashboardSerializer(serializers.Serializer[Any]):
    """`GET /v1/dashboard` (ADR-090) — минимальный дашборд запуска: ТОЛЬКО
    «что требует моего действия». «Мои сделки» на экране — переиспользование
    уже реального `GET /v1/contracts` (ADR-090 §1)."""

    attention = DashboardAttentionItemSerializer(many=True)


class SectionCounterpartySerializer(serializers.Serializer[Any]):
    """`display_name` = null при show_name=False (только по ссылке профиля).
    `avatar_url` (ADR-173) = null: фото нет ЛИБО зрителю нельзя
    (`avatar_visibility=deals_only` без завершённой сделки, ADR-103) —
    строка раздела рисует инициалы, как рисовала до фото."""

    profile_id = serializers.UUIDField()
    display_name = serializers.CharField(allow_null=True)
    avatar_url = serializers.CharField(allow_null=True)


class StageItemSerializer(serializers.Serializer[Any]):
    """Строка раздела «Этапы»: лист дерева этапов договора в исполнении.
    Деньги — строкой + валюта (CLAUDE.md), обе части null у листа без суммы."""

    id = serializers.UUIDField()
    contract_id = serializers.UUIDField()
    contract_title = serializers.CharField()
    title = serializers.CharField()
    status = serializers.CharField()
    amount = serializers.CharField(allow_null=True)
    amount_currency = serializers.CharField(allow_null=True)
    deadline = serializers.DateTimeField(allow_null=True)
    side = serializers.ChoiceField(choices=["customer", "contractor"])
    counterparty = SectionCounterpartySerializer()


class StagesSerializer(serializers.Serializer[Any]):
    """`GET /v1/dashboard/stages` — раздел «Этапы» (отсмотр 2026-08-22)."""

    items = StageItemSerializer(many=True)


class PaymentItemSerializer(serializers.Serializer[Any]):
    """Строка раздела «Платежи». `state` выводится на бэке
    (selectors._payment_state) — фронт не повторяет доменную логику."""

    milestone_id = serializers.UUIDField()
    contract_id = serializers.UUIDField()
    contract_title = serializers.CharField()
    milestone_title = serializers.CharField()
    amount = serializers.CharField()
    amount_currency = serializers.CharField()
    payment_method = serializers.CharField(allow_null=True)
    state = serializers.ChoiceField(choices=["awaiting_confirmation", "upcoming", "paid"])
    paid_confirmed_by_me = serializers.BooleanField()
    paid_confirmed_by_counterparty = serializers.BooleanField()
    accepted_at = serializers.DateTimeField(allow_null=True)
    deadline = serializers.DateTimeField(allow_null=True)
    side = serializers.ChoiceField(choices=["customer", "contractor"])
    counterparty = SectionCounterpartySerializer()


class PaymentsSerializer(serializers.Serializer[Any]):
    """`GET /v1/dashboard/payments` — раздел «Платежи» (отсмотр 2026-08-22)."""

    items = PaymentItemSerializer(many=True)


class SearchPersonSerializer(serializers.Serializer[Any]):
    """Человек в выдаче поиска (ADR-114): только по @хендлу/телефону — ФИО
    зашифровано (crypto-shredding), поиска по имени нет by design."""

    profile_id = serializers.UUIDField()
    handle = serializers.CharField(allow_null=True)
    display_name = serializers.CharField(allow_null=True)
    city_name = serializers.CharField(allow_blank=True)
    # Вариант А (2026-08-24): телефонное совпадение без SMS-верификации.
    phone_unverified = serializers.BooleanField(required=False)
    # ADR-121/122: найден по сфере запроса — "deals" (завершённые сделки) или
    # "declared" (заявил сферу в профиле), а не по адресу.
    sphere_match = serializers.ChoiceField(choices=["deals", "declared"], required=False)


class SearchGroupSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    name = serializers.CharField()
    kind = serializers.CharField()
    join_policy = serializers.CharField()
    handle = serializers.CharField(allow_null=True)
    members_count = serializers.IntegerField()
    # ADR-121: сфера каталога объединения ("" — легаси без сферы).
    sphere_code = serializers.CharField(allow_blank=True, required=False, default="")


class SearchSphereSerializer(serializers.Serializer[Any]):
    """Сфера, распознанная в запросе (ADR-121) — фронт показывает «по сфере: …»."""

    code = serializers.CharField()
    name = serializers.CharField()


class CatalogWorkAreaSerializer(serializers.Serializer[Any]):
    """Регион работы в каталожной выдаче (план 11.09 §5, ADR-184) — тот же
    смысл ключей, что `WorkAreaSerializer` (`apps.profiles.api.serializers`),
    но независимая копия полей: api-слой чужого приложения из dashboards не
    импортируем (тот же приём, что `_localized_name` в selectors.py)."""

    scope = serializers.ChoiceField(choices=["world", "country", "region", "city"])
    location = serializers.DictField(allow_null=True, required=False)


class CatalogItemSerializer(serializers.Serializer[Any]):
    """Строка каталожной выдачи (план 11.09 §5, ADR-184): исполнитель,
    подошедший под фильтры гео/сфер/опыта. `completed_deals_count` — «опыт»
    (завершённые сделки ИМЕННО исполнителем, apps.reputation).

    `geo_match` (ADR-193, 18.09): "local" — профиль указал СВОЁ гео уровня
    страна/регион/город, покрывающее запрос; "remote" — совпал ТОЛЬКО через
    `scope=world` («работаю удалённо»); `null` — гео-фильтр не задан вовсе,
    группировать нечего. Порядок выдачи: сначала все `local`, потом
    `remote` — фронт группирует РОВНО так, как отдал бэк, не пересчитывает."""

    profile_id = serializers.UUIDField()
    handle = serializers.CharField(allow_null=True)
    display_name = serializers.CharField(allow_null=True)
    avatar_url = serializers.CharField(allow_null=True)
    completed_deals_count = serializers.IntegerField()
    work_areas = CatalogWorkAreaSerializer(many=True)
    geo_match = serializers.ChoiceField(choices=["local", "remote"], allow_null=True)


class CatalogPageSerializer(serializers.Serializer[Any]):
    """Страница каталога — keyset-пагинация (план 11.09 §5, ADR-184):
    `next_cursor` непрозрачный, `null` на последней странице (тот же приём,
    что `apps.geo.api.serializers.CityPageSerializer`/
    `apps.notifications.api.serializers.NotificationFeedSerializer`)."""

    items = CatalogItemSerializer(many=True)
    next_cursor = serializers.CharField(allow_null=True)


class SearchSerializer(serializers.Serializer[Any]):
    """`GET /v1/dashboard/search` (ADR-114). `applied_zone` — фактическая
    зона (запрошенная сужается до доступной по данным зрителя).

    `catalog` (план 11.09 §5, ADR-184) — НЕЗАВИСИМАЯ ветка той же выдачи:
    каталожный фильтр исполнителей (гео/сферы/опыт, keyset-пагинация), не
    замена `profiles`/`groups`/`spheres` выше (адресная находимость по
    хендлу/телефону/тексту сферы) — считается, только если запрошены
    фильтры каталога (см. `api/views.py::_catalog_requested`); иначе
    приходит пустым (`items: []`, `next_cursor: null`)."""

    applied_zone = serializers.ChoiceField(choices=["world", "country", "city"])
    profiles = SearchPersonSerializer(many=True)
    groups = SearchGroupSerializer(many=True)
    spheres = SearchSphereSerializer(many=True, required=False, default=list)
    catalog = CatalogPageSerializer(required=False)
