from __future__ import annotations

from typing import Any

from rest_framework import serializers
from rest_framework.request import Request

from common.i18n import DEFAULT_LOCALE, resolve_request_locale

from ..models import City, Country, Region
from ..selectors import format_region_code


class CountrySerializer(serializers.ModelSerializer[Country]):
    class Meta:
        model = Country
        fields = ["code"]


def _display_name(obj: City | Region, request: Request | None) -> str:
    """Название НА ЯЗЫКЕ ЗРИТЕЛЯ (план 11.09 §2b, ADR-181): локаль запроса —
    `common.i18n.resolve_request_locale`, тот же механизм, что у остальных
    API проекта (apps.catalog/apps.dashboards/…). `name_i18n` — уже ГОТОВОЕ
    (предпочитаемое имя локали, а если такого нет — любое непустое
    неисторическое, apps.geo.services.refresh_city_name_i18n/
    refresh_region_name_i18n) значение по локали, поэтому здесь только
    словарный доступ — ни JOIN'а, ни доп. запроса на строку выдачи.
    Фолбэк: `name_i18n[locale]` → `name` (как дал источник) → `name_latin`.
    `request=None` (сериализатор без контекста, например в тестах) —
    `DEFAULT_LOCALE`, как и `resolve_request_locale` для анонимного
    запроса без Accept-Language."""
    locale = resolve_request_locale(request) if request is not None else DEFAULT_LOCALE
    name_i18n: dict[str, str] = obj.name_i18n or {}
    return name_i18n.get(locale) or obj.name or obj.name_latin


class RegionSerializer(serializers.ModelSerializer[Region]):
    # Составной код (`<страна>-<код>`, selectors.format_region_code) —
    # ИМ фильтруют /v1/geo/cities?region=, а не сырым Region.code (тот
    # уникален только в паре со страной, см. models.Region).
    code = serializers.SerializerMethodField()
    country = serializers.CharField(source="country_id")
    display_name = serializers.SerializerMethodField()

    class Meta:
        model = Region
        fields = ["code", "country", "name", "name_latin", "name_i18n", "display_name"]

    def get_code(self, obj: Region) -> str:
        return format_region_code(obj)

    def get_display_name(self, obj: Region) -> str:
        return _display_name(obj, self.context.get("request"))


class CitySerializer(serializers.ModelSerializer[City]):
    country = serializers.CharField(source="country_id")
    region = serializers.SerializerMethodField()
    # Название региона НА ЯЗЫКЕ ЗРИТЕЛЯ — рядом с самим городом (ADR-193):
    # фильтр поиска разрешает ввести сразу город, без прохода «страна →
    # регион», и подставляет его страну/регион сам (владелец 18.09: «вводит
    # город, а ему сразу подставляют регион, так быстрее»). Тогда строка
    # выдачи обязана показывать, ЧТО именно подставится («Алматы ·
    # Алматинская обл., Казахстан») — иначе одноимённые города разных стран
    # в списке неразличимы. Доп. запроса нет: `region` уже приходит через
    # `select_related` (selectors.list_cities), а `display_name` региона —
    # тот же словарный доступ к `name_i18n`, что у самого города.
    region_name = serializers.SerializerMethodField()
    display_name = serializers.SerializerMethodField()

    class Meta:
        model = City
        fields = [
            "id",
            "country",
            "region",
            "region_name",
            "name",
            "name_latin",
            "name_i18n",
            "display_name",
            "population",
        ]

    def get_region(self, obj: City) -> str | None:
        region = obj.region
        return format_region_code(region) if region is not None else None

    def get_region_name(self, obj: City) -> str | None:
        """Название региона на языке зрителя; `None` — у города нет региона
        (не у каждой страны источника есть деление первого уровня, см.
        models.City.region)."""
        region = obj.region
        return _display_name(region, self.context.get("request")) if region is not None else None

    def get_display_name(self, obj: City) -> str:
        return _display_name(obj, self.context.get("request"))


class CityPageSerializer(serializers.Serializer[Any]):
    items = CitySerializer(many=True)
    next_cursor = serializers.CharField(allow_null=True)
