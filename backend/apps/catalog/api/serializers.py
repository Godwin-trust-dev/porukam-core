from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import ContractTypeCatalogItem, MaterialCatalogItem, Sphere


def localized_name(name_i18n: dict[str, str], locale: str) -> str:
    """`name_i18n.get(locale) or name_i18n.get("ru") or <первое, что есть>`
    (ADR-091 §2) — тот же порядок фолбэка, что уже задокументирован
    `apps.l10n.selectors` («name_i18n/body_i18n `.get(locale, "ru")`,
    common/i18n.py»); последний шаг («первое, что есть») — оборонительный,
    для строк без `ru`-ключа вообще (в текущих сидах такого нет)."""
    return name_i18n.get(locale) or name_i18n.get("ru") or next(iter(name_i18n.values()), "")


class SphereSerializer(serializers.ModelSerializer[Sphere]):
    name = serializers.SerializerMethodField()

    class Meta:
        model = Sphere
        fields = ["code", "name"]
        read_only_fields = fields

    def get_name(self, obj: Sphere) -> str:
        # ADR-097: для не-ru локалей имя приходит из языкового пакета
        # (`catalog.spheres.*`, там все сферы), name_i18n — фолбэк; для ru
        # контекст пакета пуст (RU-контур остаётся на name_i18n).
        pack_names: dict[str, str] = self.context.get("pack_names") or {}
        return pack_names.get(obj.code) or localized_name(obj.name_i18n, self.context["locale"])


class WorkTypeHitSerializer(serializers.Serializer[Any]):
    """Совпавший «тип работ» в выдаче `GET /spheres?q=` (ADR-100): категория
    чек-листа + её сфера (код и имя) — фронт выбирает сферу и вид работ одним
    нажатием."""

    code = serializers.CharField()
    name = serializers.CharField()
    sphere_code = serializers.CharField()
    sphere_name = serializers.CharField()


class SphereListSerializer(serializers.Serializer[Any]):
    """GET /spheres (ADR-091 §1/§3) — `popular` всегда `[]`: нет модели/поля
    популярности, ничего не выдумываем. `work_types` (ADR-100) — типы работ,
    совпавшие с `q` (без `q` — `[]`)."""

    results = SphereSerializer(many=True)
    popular = SphereSerializer(many=True)
    work_types = WorkTypeHitSerializer(many=True)


class WorkTypeSerializer(serializers.Serializer[Any]):
    """«Вид работ» — НЕ модель, DISTINCT `ChecklistTemplateItem.category`
    (ADR-091). `name` — человекочитаемое имя из языкового пакета
    (`catalog.categories.<sphere_code>.<code>`, ADR-097/ADR-190), НЕ код:
    `api/views.py::WorkTypeListView` исключает из выдачи коды без подписи ни
    в одной локали, а не подставляет вместо имени сам код (прежнее
    поведение ADR-091 §1 отменено ADR-190 — 12.09)."""

    code = serializers.CharField()
    name = serializers.CharField()
    sphere_code = serializers.CharField()


class WorkTypeListSerializer(serializers.Serializer[Any]):
    results = WorkTypeSerializer(many=True)


class MaterialCatalogItemSerializer(serializers.Serializer[Any]):
    ref = serializers.CharField(source="code")
    title = serializers.SerializerMethodField()
    default_unit = serializers.SerializerMethodField()

    def get_title(self, obj: MaterialCatalogItem) -> str:
        return localized_name(obj.name_i18n, self.context["locale"])

    def get_default_unit(self, obj: MaterialCatalogItem) -> str | None:
        return obj.suggested_unit or None


class MaterialCatalogListSerializer(serializers.Serializer[Any]):
    results = MaterialCatalogItemSerializer(many=True)


class UnitOptionSerializer(serializers.Serializer[Any]):
    """Код — сам себе `label` (ADR-091 §1: единиц измерения как модели нет,
    подсказки/переводов негде взять — не выдумываем)."""

    code = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]  # DRF Field.label name clash


class UnitOptionListSerializer(serializers.Serializer[Any]):
    results = UnitOptionSerializer(many=True)


class ContractTypeOptionSerializer(serializers.ModelSerializer[ContractTypeCatalogItem]):
    """GET /contract-types (ADR-094) — ровно то, что нужно мастеру для
    выбора кода: `code` (уйдёт в `POST /contracts.contract_type_code`),
    локализованное `name`, `client_option` для группировки. Налоговые
    заметки/сегменты фронту на этом шаге не нужны — не отдаём."""

    name = serializers.SerializerMethodField()

    class Meta:
        model = ContractTypeCatalogItem
        fields = ["code", "name", "client_option"]
        read_only_fields = fields

    def get_name(self, obj: ContractTypeCatalogItem) -> str:
        return localized_name(obj.name_i18n, self.context["locale"])


class ContractTypeOptionListSerializer(serializers.Serializer[Any]):
    results = ContractTypeOptionSerializer(many=True)


class ChecklistRecommendationsSerializer(serializers.Serializer[Any]):
    """GET /checklist-recommendations (ADR-091 §1) — плоский список
    локализованных формулировок (`description_i18n.get(locale) or
    description`), не объекты — форма, которую уже ждёт фронт
    (`{results: string[]}`)."""

    results = serializers.ListField(child=serializers.CharField())
