"""Use cases apps.catalog (tech-spec.md §6.6; docs/catalog-v2.md §0, §7).

`compute_segment` — фасад для будущего apps.contracts (Э4): нижний слой не
импортирует Contract (import-linter, CLAUDE.md), поэтому статус стороны
передаётся примитивами, а не доменным объектом.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from . import checklist_markdown, selectors
from .models import (
    ChecklistTemplateItem,
    ChecklistTemplatePickStat,
    ContractTypeCatalogItem,
    MaterialCatalogItem,
    Sphere,
)


class ContractTypeExcludedError(ValueError):
    """`default_segment=excluded` — платформа такой тип сделки не готовит
    (§6.6 правило 5; будущий api/-код: 403 `contract_type_excluded`)."""


class ContractTypeNotYetSupportedError(ValueError):
    """`needs_special_handling=True` — недвижимость/транспорт и т.п., в Р1
    только честная заглушка «этот тип сделки скоро» (docs/catalog-v2.md §0
    п.5, §7 п.6; будущий api/-код: 409 `not_yet_supported`)."""


class SmzOwnProductionRequiredError(ValueError):
    """ст. 4 ФЗ-422: самозанятому запрещена перепродажа чужого товара —
    `sale_business` доступен СМЗ-продавцу только для товара собственного
    производства (docs/catalog-v2.md §2, строка `sale_business`)."""


def compute_segment(
    contract_type_code: str,
    *,
    contractor_acting_as: str = "person",
    contractor_has_business_status: bool = False,
) -> str:
    """Сегмент монетизации (ADR-058, tech-spec.md §6.6).

    Для типов с `requires_service_flag=True` сегмент зависит от статуса
    исполнителя/арендодателя НА МОМЕНТ КОНКРЕТНОГО договора (`rent_items`,
    `rent_home`). Бизнес-статус — только СОБСТВЕННЫЙ СМЗ/ИП: представитель
    чужого юрлица (`contractor_acting_as="person"`,
    `contractor_has_business_status=False`) остаётся в `free_c2c`, даже если
    он же — Representative чужого ООО в другом контексте (CLAUDE.md;
    apps.entities не даёт такому пользователю `has_business_status=True`).
    Для остальных типов (уже расщеплённых на отдельные коды клиентского
    дерева — `sale_personal`/`sale_business` и т.п.) `default_segment`
    возвращается как есть.
    """
    ctype = ContractTypeCatalogItem.objects.get(code=contract_type_code)

    if ctype.needs_special_handling:
        raise ContractTypeNotYetSupportedError(
            f"{contract_type_code!r}: этот тип сделки скоро (docs/catalog-v2.md §0 п.5)"
        )
    if ctype.default_segment == ContractTypeCatalogItem.Segment.EXCLUDED:
        raise ContractTypeExcludedError(
            f"{contract_type_code!r}: платформа такой тип сделки не готовит"
        )

    if ctype.requires_service_flag:
        is_business = contractor_acting_as == "business" or contractor_has_business_status
        return (
            ContractTypeCatalogItem.Segment.PAID_BUSINESS
            if is_business
            else ContractTypeCatalogItem.Segment.FREE_C2C
        )

    return ctype.default_segment


def resolve_service_contract_type_code(
    *,
    contractor_acting_as: str = "person",
    contractor_has_business_status: bool = False,
) -> str:
    """Ветка «Услуга» клиентского дерева (docs/catalog-v2.md §1): тип
    вычисляется автоматически по статусу исполнителя, пользователь выбирает
    только опцию «Услуга», не код.

    Р-1 (обязательный тест, CLAUDE.md): представитель чужого ООО, оказывающий
    услугу лично (`contractor_acting_as="person"`,
    `contractor_has_business_status=False`) → `services_individual`, не
    `services_business` — представительство чужого юрлица статуса не даёт.
    """
    if contractor_acting_as == "business" or contractor_has_business_status:
        return "services_business"
    return "services_individual"


def assert_smz_own_production(
    contract_type_code: str, *, seller_tax_regime: str, is_own_production: bool
) -> None:
    """ст. 4 ФЗ-422: у `sale_business` самозанятый продавец (`seller_tax_regime="npd"`)
    может продавать только товар собственного производства."""
    ctype = ContractTypeCatalogItem.objects.get(code=contract_type_code)
    if ctype.smz_own_production_only and seller_tax_regime == "npd" and not is_own_production:
        raise SmzOwnProductionRequiredError(
            f"{contract_type_code!r}: самозанятому запрещена перепродажа "
            "чужого товара (ст. 4 ФЗ-422)"
        )


# --- Востребованность пунктов чек-листа (ADR-153) ---


def record_checklist_pick(
    *, description: str, sphere_id: UUID | None = None
) -> ChecklistTemplateItem | None:
    """Фасад «пункт шаблона попал в чек-лист настоящего этапа» (ADR-153) —
    единственный способ двинуть `ChecklistTemplatePickStat`.

    Зовёт `apps.milestones.services.create_checklist_item` в СВОЕЙ
    транзакции: направление milestones → catalog разрешено import-linter'ом,
    обратное — нет, поэтому счётчик денормализован в каталоге и приезжает
    сюда фасадом, а не выбирается каталогом из чужих таблиц.

    Возвращает шаблонный пункт, к которому отнесён пик (вызывающая сторона
    кладёт его в `ChecklistItem.source_template`), либо `None` — текст
    написан руками и ни одному шаблону не соответствует (счётчик тогда
    не двигается вовсе).

    Инкремент атомарен: одно UPDATE-выражение с `F()` (никакого
    read-modify-write), гонка на первом пике слага разрешается уникальным
    индексом `slug` — проигравший вставку просто инкрементирует. Наведённой
    идемпотентности у фасада нет и быть не может: единица счёта — СОЗДАННАЯ
    строка `ChecklistItem`, а не HTTP-запрос (`POST .../checklist-items` не
    денежный и не подписной, `Idempotency-Key` на нём нет — повторный POST
    создаёт ВТОРОЙ пункт чек-листа, и это честно второй пик). Зато пик
    откатывается вместе с транзакцией, в которой создавался пункт."""
    template = selectors.find_checklist_template_by_description(
        description=description, sphere_id=sphere_id
    )
    if template is None:
        return None
    _increment_pick_count(template.slug)
    return template


def _increment_pick_count(slug: str) -> None:
    now = timezone.now()
    updated = ChecklistTemplatePickStat.objects.filter(slug=slug).update(
        pick_count=F("pick_count") + 1, last_picked_at=now
    )
    if updated:
        return
    try:
        # Вложенный atomic: IntegrityError на гонке первой вставки не должен
        # ломать транзакцию вызывающей стороны (создание пункта чек-листа).
        with transaction.atomic():
            ChecklistTemplatePickStat.objects.create(slug=slug, pick_count=1, last_picked_at=now)
    except IntegrityError:
        ChecklistTemplatePickStat.objects.filter(slug=slug).update(
            pick_count=F("pick_count") + 1, last_picked_at=now
        )


# --- import_checklists / export_checklists_i18n (ADR-081, П-03) ---

_TRANSLIT_MAP = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "",
    "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}  # fmt: skip


@dataclass(frozen=True)
class SphereImportReport:
    """Отчёт по одному CL-файлу — печатается management-командой построчно
    (приёмка П-03: «число пунктов по сферам — в отчёте PR»)."""

    sphere_code: str
    items_created: int
    items_new_version: int
    items_unchanged: int
    materials_created: int
    materials_updated: int
    materials_unchanged: int
    unresolved_material_refs: tuple[str, ...]


@dataclass(frozen=True)
class ChecklistImportReport:
    spheres: tuple[SphereImportReport, ...]

    @property
    def total_items_created(self) -> int:
        return sum(s.items_created for s in self.spheres)

    @property
    def total_items_new_version(self) -> int:
        return sum(s.items_new_version for s in self.spheres)

    @property
    def total_items_unchanged(self) -> int:
        return sum(s.items_unchanged for s in self.spheres)

    @property
    def total_materials_created(self) -> int:
        return sum(s.materials_created for s in self.spheres)


@transaction.atomic
def import_checklists(checklists_dir: Path) -> ChecklistImportReport:
    """Идемпотентный версионированный импорт `docs/content/checklists/
    CL-*_GLOBAL.md` (ADR-081, П-03) в `ChecklistTemplateItem`/
    `MaterialCatalogItem` — вызывается management-командой `import_checklists`
    (тонкая обёртка, вся логика здесь, по образцу apps.l10n.services.
    import_pack). Парсинг файлов — чистые функции `.checklist_markdown`,
    здесь только upsert.

    Слаг `<сфера>.<категория>.<код пункта>` присваивается ОДИН РАЗ при
    первом импорте строки и дальше не меняется. Повторный импорт с тем же
    текстом — no-op (сравнение по содержимому, не по хешу файла целиком, —
    правка ОДНОГО пункта не должна плодить версии у остальных). Правка
    формулировки пункта заводит НОВУЮ версию (`version + 1`,
    `is_current=True`), у предыдущей строки `is_current` становится
    `False` — она не удаляется и не редактируется (на неё могут ссылаться
    уже сделанные снепшоты договоров, `ContractVersion`)."""
    return ChecklistImportReport(
        spheres=tuple(
            _import_sphere_file(checklist_markdown.parse_file(path))
            for path in checklist_markdown.iter_checklist_files(checklists_dir)
        )
    )


class _ChecklistContent(Protocol):
    """Общая форма `ChecklistTemplateItem` и `checklist_markdown.
    ParsedChecklistItem` — обе структурно её удовлетворяют, отдельного
    приведения типов между ORM-моделью и dataclass-парсера не нужно.
    Свойства (не переменные) — `ParsedChecklistItem` заморожен (frozen
    dataclass), протокол с изменяемыми полями ему бы не соответствовал."""

    @property
    def description(self) -> str: ...
    @property
    def check_method(self) -> str: ...
    @property
    def photo_required(self) -> bool: ...
    @property
    def is_default(self) -> bool: ...
    @property
    def category(self) -> str: ...
    @property
    def is_jurisdiction_sensitive(self) -> bool: ...


def _content_tuple(item: _ChecklistContent) -> tuple[str, str, bool, bool, str, bool]:
    return (
        item.description,
        item.check_method,
        item.photo_required,
        item.is_default,
        item.category,
        item.is_jurisdiction_sensitive,
    )


def _import_sphere_file(parsed: checklist_markdown.ParsedSphereFile) -> SphereImportReport:
    sphere, _ = Sphere.objects.get_or_create(
        code=parsed.sphere_code, defaults={"name_i18n": {"ru": parsed.sphere_name}}
    )

    items_created = items_new_version = items_unchanged = 0
    current_by_ref: dict[tuple[str, str], ChecklistTemplateItem] = {}

    for parsed_item in parsed.items:
        slug = f"{parsed.sphere_code}.{parsed_item.category}.{parsed_item.code}"
        existing = ChecklistTemplateItem.objects.filter(slug=slug, is_current=True).first()

        if existing is not None and _content_tuple(existing) == _content_tuple(parsed_item):
            update_fields = []
            if existing.order != parsed_item.order:
                existing.order = parsed_item.order
                update_fields.append("order")
            if existing.source_file != parsed.source_file:
                existing.source_file = parsed.source_file
                update_fields.append("source_file")
            if update_fields:
                existing.save(update_fields=update_fields)
            items_unchanged += 1
            current_by_ref[(parsed_item.category, parsed_item.code)] = existing
            continue

        next_version = 1
        if existing is not None:
            existing.is_current = False
            existing.save(update_fields=["is_current"])
            next_version = existing.version + 1
            items_new_version += 1
        else:
            items_created += 1

        current_by_ref[(parsed_item.category, parsed_item.code)] = (
            ChecklistTemplateItem.objects.create(
                sphere=sphere,
                slug=slug,
                version=next_version,
                is_current=True,
                category=parsed_item.category,
                code=parsed_item.code,
                description=parsed_item.description,
                # GLOBAL-формат: «формулировка» уже несёт единственный измеримый
                # критерий (00_индекс.md §2) — отдельного текста критерия
                # markdown не содержит (см. docstring ChecklistTemplateItem).
                measurable_criterion=parsed_item.description,
                check_method=parsed_item.check_method,
                photo_required=parsed_item.photo_required,
                is_default=parsed_item.is_default,
                is_jurisdiction_sensitive=parsed_item.is_jurisdiction_sensitive,
                source_file=parsed.source_file,
                order=parsed_item.order,
            )
        )

    materials_created = materials_updated = materials_unchanged = 0
    unresolved: list[str] = []

    for parsed_material in parsed.materials:
        code = _material_code(
            parsed.sphere_code, parsed_material.category, parsed_material.position
        )
        defaults = {
            "sphere": sphere,
            "name_i18n": {"ru": parsed_material.position},
            "suggested_unit": parsed_material.unit,
            "is_active": True,
        }
        material = MaterialCatalogItem.objects.filter(code=code).first()
        if material is None:
            material = MaterialCatalogItem.objects.create(code=code, **defaults)
            materials_created += 1
        elif any(getattr(material, field) != value for field, value in defaults.items()):
            for field, value in defaults.items():
                setattr(material, field, value)
            material.save(update_fields=list(defaults.keys()))
            materials_updated += 1
        else:
            materials_unchanged += 1

        for ref_category, ref_code in parsed_material.linked_refs:
            item = current_by_ref.get((ref_category, ref_code))
            if item is None:
                unresolved.append(f"{parsed.sphere_code}.{ref_category}.{ref_code}")
                continue
            if item.catalog_item_id != material.id:
                item.catalog_item = material
                item.save(update_fields=["catalog_item"])

    return SphereImportReport(
        sphere_code=parsed.sphere_code,
        items_created=items_created,
        items_new_version=items_new_version,
        items_unchanged=items_unchanged,
        materials_created=materials_created,
        materials_updated=materials_updated,
        materials_unchanged=materials_unchanged,
        unresolved_material_refs=tuple(unresolved),
    )


def _material_code(sphere_code: str, category: str, position: str) -> str:
    """Детерминированный человекочитаемый `code` `MaterialCatalogItem` —
    тот же слаг при каждом импорте (идемпотентность через
    `update_or_create`-подобный upsert по `code`)."""
    slug = _translit_slug(position)
    prefix = f"{sphere_code}_{category}_"
    code = f"{prefix}{slug}"
    if len(code) <= 64:
        return code
    digest = hashlib.sha256(position.encode("utf-8")).hexdigest()[:8]
    return f"{prefix}{slug[: 64 - len(prefix) - 9]}_{digest}"


def _translit_slug(text: str) -> str:
    transliterated = "".join(_TRANSLIT_MAP.get(ch, ch) for ch in text.lower())
    return re.sub(r"[^a-z0-9]+", "_", transliterated).strip("_")


def export_checklists_i18n() -> dict[str, str]:
    """Экспорт актуальных версий импортированных пунктов чек-листов в
    плоский набор ключей `catalog.checklists.<slug>` → текст (RU,
    язык-источник) — вход переводческого конвейера. Формат ключа
    согласован с namespace `catalog` языковых пакетов apps.l10n
    (`catalog.<sub_ns>.<key>`, l10n/README.md): `sub_ns="checklists"`,
    `key=slug` целиком (сам slug уже содержит точки — неймспейс плоский,
    не вложенное дерево, потому что slug сам по себе уникален).

    Только `is_current=True` и непустой `slug` — ручной сид (`slug=""`,
    миграция 0006) вне этого конвейера, у него нет версии."""
    items = ChecklistTemplateItem.objects.filter(is_current=True).exclude(slug="").order_by("slug")
    return {f"catalog.checklists.{item.slug}": item.description for item in items}
