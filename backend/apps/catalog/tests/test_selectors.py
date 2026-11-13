"""apps.catalog.selectors — новые read-функции под мастер договора
(ADR-091): сферы/материалы/единицы/виды работ/рекомендации чек-листа.
`work-types`/`checklist-recommendations` завязаны на `ChecklistTemplateItem.
category` — реально заполняется ТОЛЬКО `import_checklists` (ADR-081), не
сид-миграцией 0006 — тот же приём тестов, что `test_checklist_import.py`."""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.catalog import selectors, services
from apps.catalog.models import (
    ChecklistTemplateItem,
    ChecklistTemplatePickStat,
    MaterialCatalogItem,
    Sphere,
)

pytestmark = pytest.mark.django_db

_REPO_CHECKLISTS_DIR = Path(__file__).resolve().parents[4] / "docs" / "content" / "checklists"

_SEEDED_SPHERE_CODES = {"renovation", "delivery", "education", "it", "household", "design", "other"}


@pytest.fixture
def imported():
    """Реальный контент (17 CL-*_GLOBAL.md) — заполняет `category`/`slug`/
    `is_default`, которых сид-миграция 0006 не трогает (ADR-091 «Контекст»)."""
    return services.import_checklists(_REPO_CHECKLISTS_DIR)


def test_list_active_spheres_returns_seeded_codes():
    codes = set(selectors.list_active_spheres().values_list("code", flat=True))
    assert codes >= _SEEDED_SPHERE_CODES


def test_list_active_spheres_excludes_inactive():
    Sphere.objects.create(code="zz-inactive", name_i18n={"ru": "Скрытая"}, is_active=False)
    codes = set(selectors.list_active_spheres().values_list("code", flat=True))
    assert "zz-inactive" not in codes


def test_list_active_material_catalog_includes_seeded_items():
    refs = set(selectors.list_active_material_catalog().values_list("code", flat=True))
    assert "renovation_tile" in refs
    assert "other_renovation" in refs
    assert "other_it" in refs  # другая сфера — без фильтра каталог общий (ADR-091 §«Не делать»)


def test_list_active_material_catalog_filters_by_sphere():
    refs = set(
        selectors.list_active_material_catalog(sphere_code="renovation").values_list(
            "code", flat=True
        )
    )
    assert "renovation_tile" in refs
    assert "other_it" not in refs


def test_list_active_material_catalog_excludes_inactive():
    sphere = Sphere.objects.get(code="renovation")
    MaterialCatalogItem.objects.create(
        code="zz-inactive-material", sphere=sphere, name_i18n={"ru": "x"}, is_active=False
    )
    refs = set(selectors.list_active_material_catalog().values_list("code", flat=True))
    assert "zz-inactive-material" not in refs


def test_list_unit_codes_distinct_and_nonblank():
    units = selectors.list_unit_codes()
    assert "м²" in units
    assert "рулон" in units
    assert "" not in units
    assert units == sorted(set(units))  # distinct + упорядочено


@pytest.fixture
def l10n_packs():
    """Реальные ru/en-пакеты репозитория — источник подписей категорий
    (`catalog.categories`, ADR-097/ADR-190), тот же приём, что
    `test_api.py::l10n_packs`."""
    import json

    from apps.l10n import services as l10n_services

    packs_dir = Path(__file__).resolve().parents[4] / "l10n" / "packs"
    for code in ("ru", "en"):
        l10n_services.import_pack(json.loads((packs_dir / f"{code}.json").read_text("utf-8")))


def test_list_work_type_codes_empty_before_import():
    """Сид 0006 не заполняет `category` — честно пусто, не ошибка (ADR-091)."""
    assert selectors.list_work_type_codes(sphere_code="renovation") == []


def test_list_work_type_codes_after_import(imported):
    codes = selectors.list_work_type_codes(sphere_code="renovation")
    assert "turnkey" in codes
    assert "tiling" in codes
    assert codes == sorted(set(codes))


def test_list_work_type_codes_scoped_to_sphere(imported):
    """`other` встречается почти в каждом файле — без сферы в фильтре
    `it`-категории протекли бы в `renovation` и наоборот (ADR-091 §1)."""
    renovation_codes = set(selectors.list_work_type_codes(sphere_code="renovation"))
    it_codes = set(selectors.list_work_type_codes(sphere_code="it"))
    assert "tiling" in renovation_codes
    assert "tiling" not in it_codes


def test_list_work_type_codes_union_catches_catalog_item_linked_rows_without_direct_sphere():
    """Союз условий (`selectors._by_sphere`) — ручной сид 0006 кладёт
    `catalog_item` БЕЗ `sphere` напрямую; здесь синтетическая строка того же
    вида, но С `category`, чтобы доказать её всё равно находит выборка по
    сфере (0006 сама не задаёт category, реальный `import_checklists` —
    всегда через прямой `sphere`, поэтому этот путь больше нигде не покрыт)."""
    tile = MaterialCatalogItem.objects.get(code="renovation_tile")
    assert tile.sphere_id is not None  # напоминание: sphere на МАТЕРИАЛЕ есть
    ChecklistTemplateItem.objects.create(
        catalog_item=tile,
        sphere=None,
        category="synthetic-check",
        description="x",
        measurable_criterion="x",
    )
    assert "synthetic-check" in selectors.list_work_type_codes(sphere_code="renovation")


def test_list_checklist_recommendations_defaults_before_extended_set(imported):
    """ADR-153: расширенный набор (`is_default=False`) теперь ВХОДИТ в
    выдачу, но строго после дефолтных — дефолт остаётся редакторским
    решением автора CL-файла."""
    recs = list(
        selectors.list_checklist_recommendations(sphere_code="renovation", work_type="turnkey")
    )
    flags = [item.is_default for item in recs]
    assert True in flags and False in flags, "нужна пара работ с обоими наборами"
    assert flags == sorted(flags, reverse=True)


def test_list_checklist_recommendations_orders_by_pick_count_then_order(imported):
    """ADR-153: «самые релевантные» = самые востребованные; при равенстве —
    каталожный `order` автора файла."""
    baseline = list(
        selectors.list_checklist_recommendations(sphere_code="renovation", work_type="turnkey")
    )
    assert [i.order for i in baseline if i.is_default] == sorted(
        i.order for i in baseline if i.is_default
    ), "без пиков порядок остаётся каталожным"

    last_default = [i for i in baseline if i.is_default][-1]
    assert last_default.id != baseline[0].id
    ChecklistTemplatePickStat.objects.create(slug=last_default.slug, pick_count=3)

    ranked = list(
        selectors.list_checklist_recommendations(sphere_code="renovation", work_type="turnkey")
    )
    assert ranked[0].id == last_default.id
    assert ranked[0].pick_count == 3
    rest = [i for i in ranked[1:] if i.is_default]
    assert [i.order for i in rest] == sorted(i.order for i in rest)


def test_list_checklist_recommendations_pick_count_is_shared_by_slug_across_versions(imported):
    """ADR-081 + ADR-153: у новой редакции пункта тот же `slug` — счётчик
    общий, переимпорт с правкой текста востребованность не обнуляет."""
    item = selectors.list_checklist_recommendations(
        sphere_code="renovation", work_type="turnkey"
    ).first()
    assert item is not None
    ChecklistTemplatePickStat.objects.create(slug=item.slug, pick_count=7)

    item.is_current = False
    item.save(update_fields=["is_current"])
    new_revision = ChecklistTemplateItem.objects.create(
        sphere=item.sphere,
        slug=item.slug,
        version=item.version + 1,
        is_current=True,
        category=item.category,
        code=item.code,
        description=item.description + " (уточнено)",
        measurable_criterion=item.description,
        is_default=True,
        order=item.order,
    )

    ranked = list(
        selectors.list_checklist_recommendations(sphere_code="renovation", work_type="turnkey")
    )
    assert ranked[0].id == new_revision.id
    assert ranked[0].pick_count == 7


def test_list_checklist_recommendations_zero_pick_count_for_unknown_slug(imported):
    recs = selectors.list_checklist_recommendations(sphere_code="renovation", work_type="turnkey")
    assert all(item.pick_count == 0 for item in recs)


# --- find_checklist_template_by_description (ADR-153) ------------------------


def test_find_checklist_template_by_description_matches_exact_text(imported):
    item = selectors.list_checklist_recommendations(
        sphere_code="renovation", work_type="turnkey"
    ).first()
    assert item is not None
    found = selectors.find_checklist_template_by_description(description=item.description)
    assert found is not None
    assert found.slug == item.slug


def test_find_checklist_template_by_description_returns_none_for_own_text(imported):
    assert (
        selectors.find_checklist_template_by_description(
            description="Забор покрашен в мой любимый цвет"
        )
        is None
    )


def test_find_checklist_template_by_description_prefers_milestone_sphere(imported):
    """Один и тот же текст в двух сферах: сфера этапа решает, чей пик."""
    renovation = Sphere.objects.get(code="renovation")
    other = Sphere.objects.get(code="other")
    shared_text = "Общая формулировка, встречающаяся в двух сферах"
    for sphere, slug in ((renovation, "renovation.dup.x1"), (other, "other.dup.x1")):
        ChecklistTemplateItem.objects.create(
            sphere=sphere,
            slug=slug,
            category="dup",
            code="x1",
            description=shared_text,
            measurable_criterion=shared_text,
        )

    found = selectors.find_checklist_template_by_description(
        description=shared_text, sphere_id=other.id
    )
    assert found is not None
    assert found.slug == "other.dup.x1"

    # Сфера этапа не задана (`effective_sphere_id` → None) — детерминированно
    # наименьший slug, а не случайная строка.
    fallback = selectors.find_checklist_template_by_description(description=shared_text)
    assert fallback is not None
    assert fallback.slug == "other.dup.x1"


def test_find_checklist_template_by_description_ignores_slugless_manual_seed(imported):
    """Ручной сид 0006 (`slug=""`) статистики не ведёт — за ним пик не
    закрепляется (докстринг `ChecklistTemplatePickStat`)."""
    sphere = Sphere.objects.get(code="renovation")
    manual = ChecklistTemplateItem.objects.create(
        sphere=sphere,
        description="Пункт ручного сида без слага",
        measurable_criterion="Пункт ручного сида без слага",
    )
    assert manual.slug == ""
    assert selectors.find_checklist_template_by_description(description=manual.description) is None


def test_list_checklist_recommendations_scoped_to_sphere_not_leaking_other_category(imported):
    """`category="other"` реально повторяется почти во всех 17 CL-файлов
    (verified: `grep -c '^| other |' CL-*.md`) — `sales`/`other` (сфера)
    оба заполняют её РЕАЛЬНЫМИ строками с разным содержанием, лучшая пара
    для доказательства, что фильтр по сфере не путает их."""
    sales_other = {
        i.description
        for i in selectors.list_checklist_recommendations(sphere_code="sales", work_type="other")
    }
    assert (
        "Товар соответствует описанию и фото из карточки сделки — сверка при передаче"
        in sales_other
    )

    other_sphere_other = {
        i.description
        for i in selectors.list_checklist_recommendations(sphere_code="other", work_type="other")
    }
    assert sales_other.isdisjoint(other_sphere_other)


def test_list_checklist_recommendations_empty_for_unknown_work_type(imported):
    recs = selectors.list_checklist_recommendations(
        sphere_code="renovation", work_type="does-not-exist"
    )
    assert recs.count() == 0


# --- rank_checklist_templates: один порядок на оба пути (ADR-155) -----------


def test_recommended_checklist_template_items_ranked_by_pick_count(imported):
    """Решение владельца 03.09: этапный путь подсказок
    (`GET /milestones/{id}/checklist-recommendations`, ADR-047) ранжируется
    ТЕМ ЖЕ счётчиком, что каталожный `GET /checklist-recommendations`
    (ADR-153) — общий хелпер `rank_checklist_templates`."""
    sphere = Sphere.objects.get(code="renovation")
    baseline = list(
        selectors.recommended_checklist_template_items(catalog_item_ids=[], sphere_id=sphere.id)
    )
    assert len(baseline) > 1, "для сферы нужны минимум две подсказки"
    assert all(item.pick_count == 0 for item in baseline)

    # Внутри группы `is_default` — поднимаем последний дефолтный пункт:
    # расширенный набор востребованность вперёд дефолта не выносит (ADR-153).
    last_default = [item for item in baseline if item.is_default][-1]
    assert last_default.id != baseline[0].id
    ChecklistTemplatePickStat.objects.create(slug=last_default.slug, pick_count=9)

    ranked = list(
        selectors.recommended_checklist_template_items(catalog_item_ids=[], sphere_id=sphere.id)
    )
    assert ranked[0].id == last_default.id
    assert ranked[0].pick_count == 9


def test_recommended_checklist_template_items_tie_break_is_order_then_slug(imported):
    """При равном `pick_count` — каталожный `order`, затем `slug`: выдача
    детерминирована, а не «как ляжет» в БД."""
    sphere = Sphere.objects.get(code="renovation")
    ranked = list(
        selectors.recommended_checklist_template_items(catalog_item_ids=[], sphere_id=sphere.id)
    )
    keys = [(not item.is_default, item.order, item.slug) for item in ranked]
    assert keys == sorted(keys)


# --- is_selectable_work_type (ADR-190, 12.09) ------------------------------


def test_is_selectable_work_type_true_for_labeled_real_code(imported, l10n_packs):
    assert selectors.is_selectable_work_type(sphere_code="renovation", code="turnkey") is True


def test_is_selectable_work_type_false_for_unknown_code(imported, l10n_packs):
    """Нет пунктов чек-листа под этим кодом вовсе — не вид работ."""
    assert (
        selectors.is_selectable_work_type(sphere_code="renovation", code="does-not-exist") is False
    )


def test_is_selectable_work_type_false_without_any_label(imported, l10n_packs):
    """4 кода `other.*` (ADR-190): пункты чек-листа есть, подписи — нет ни в
    ru, ни в en."""
    assert selectors.is_selectable_work_type(sphere_code="other", code="loan") is False
    assert selectors.is_selectable_work_type(sphere_code="other", code="rent_home") is False
    assert selectors.is_selectable_work_type(sphere_code="other", code="rent_items") is False
    assert selectors.is_selectable_work_type(sphere_code="other", code="sale_vehicle") is False


def test_is_selectable_work_type_false_when_packs_not_imported(imported):
    """Без импортированных пакетов подписи нет ни у одного кода — честно
    False, а не True «по умолчанию»."""
    assert selectors.is_selectable_work_type(sphere_code="renovation", code="turnkey") is False


def test_is_selectable_work_type_true_for_other_other(imported, l10n_packs):
    """`other.other` (универсальный шаблон) подписан («Прочее») — остаётся
    выбираемым в отличие от 4 социальных архетипов той же сферы."""
    assert selectors.is_selectable_work_type(sphere_code="other", code="other") is True
