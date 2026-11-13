"""П-03 (ADR-081): import_checklists/export_checklists_i18n — идемпотентность,
версионирование по slug, привязка материалов, покрытие всех сфер
docs/content/checklists."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.catalog import selectors, services
from apps.catalog.checklist_markdown import ChecklistMarkdownError, parse_file
from apps.catalog.models import ChecklistTemplateItem, MaterialCatalogItem, Sphere

pytestmark = pytest.mark.django_db

_REPO_CHECKLISTS_DIR = Path(__file__).resolve().parents[4] / "docs" / "content" / "checklists"

# 17 «настоящих» сфер (00_индекс.md «Итого»: «17 сфер + other + social»);
# `other` — отдельная 18-я сфера-«прочее», `social` — НЕ сфера (акты
# передачи архетипа social, CL-other_GLOBAL.md §2), import_checklists её
# сознательно не трогает (заголовок таблицы «шаблон», не «категория»).
_SEVENTEEN_SPHERES = {
    "renovation", "household", "appliance", "auto", "garden", "delivery", "sales",
    "it", "design", "media", "marketing", "events", "education", "beauty", "care",
    "pets", "business",
}  # fmt: skip


def _write_sphere_file(tmp_path: Path, filename: str, body: str) -> Path:
    path = tmp_path / filename
    path.write_text(body, encoding="utf-8")
    return path


_MINIMAL_SPHERE_FILE = """# CL-testsphere (GLOBAL) — тестовая сфера

> Тестовый файл П-03. Сфера 99: `testsphere` — Тестовая сфера.

## 1. Чек-листы приёмки по категориям

### 1.1. `testsphere.cat1` — Категория 1

| категория | код пункта | формулировка | как проверить | фото | дефолт |
|---|---|---|---|---|---|
| cat1 | work.1 | Первый пункт (текст версии 1) | осмотр | да | да |
| cat1 | work.2 | Второй пункт | замер | — | нет |
| cat1 | other | Тип работ «Прочее»: пункты формулируются сторонами | — | — | — |

**Базовый чек-лист категории:** `work.1`, `work.2`.

## 2. Справочник материалов

| категория | позиция | единица | правило цены | связанные пункты чек-листа |
|---|---|---|---|---|
| cat1 | Тестовый материал | шт | за шт | cat1: work.1–2 |
| cat1 | Прочее (свободная позиция) | вручную | вручную | — |

## 3. Сводка и самопроверка

текст самопроверки.
"""

_JURISDICTION_MARKER_FILE = """# CL-testjuris (GLOBAL) — тестовая сфера (маркер [Л])

> Тестовый файл П-03. Сфера 99: `testjuris` — Тестовая сфера маркера.

## 1. Чек-листы приёмки по категориям

### 1.1. `testjuris.cat1` — Категория 1

| категория | код пункта | формулировка | как проверить | фото | дефолт |
|---|---|---|---|---|---|
| cat1 | work.1 | Обычный пункт без маркера | осмотр | — | да |
| cat1 | work.2 | Пункт со страновой реалией [Л] | документ | — | нет |
| cat1 | work.3 | Пункт с латинским маркером [L] | документ | — | нет |
| cat1 | other | Тип работ «Прочее»: пункты формулируются сторонами | — | — | — |

## 2. Справочник материалов

## 3. Сводка

текст.
"""

_SOCIAL_LIKE_FILE = """# CL-social_like (GLOBAL) — тест блока актов

> Сфера 99: `social_like` — Тест. Блок актов передачи, не сфера услуг.

## 2. Блок социальных договоров (архетип social)

### 2.1. `social.tmpl` — Шаблон акта

| шаблон | код пункта | формулировка | как проверить | фото | дефолт |
|---|---|---|---|---|---|
| tmpl | transfer.1 | Пункт акта передачи | документ | — | да |

## 3. Сводка

текст.
"""


def test_parse_file_skips_other_marker_rows_and_free_material_position(tmp_path: Path) -> None:
    path = _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)
    parsed = parse_file(path)

    assert [item.code for item in parsed.items] == ["work.1", "work.2"]
    assert [m.position for m in parsed.materials] == ["Тестовый материал"]
    assert parsed.materials[0].linked_refs == (("cat1", "work.1"), ("cat1", "work.2"))
    assert parsed.sphere_name == "Тестовая сфера"


@pytest.mark.parametrize(
    ("header_line", "expected_name"),
    [
        # CL-sales_GLOBAL.md — архетип сделки в скобках.
        (
            "> Тестовый файл. Сфера 99: `testsphere` — Продажи (архетип сделки sale, док 24).",
            "Продажи",
        ),
        # CL-other_GLOBAL.md — оговорка про единственную категорию + «+ блок …» дальше.
        (
            "> Тестовый файл. Сфера 99: `testsphere` — Прочее "
            "(единственная категория `other.other`) + блок социальных договоров "
            "(архетип social, док 24 — не сфера, чек-листы здесь = шаблоны актов передачи).",
            "Прочее",
        ),
        # CL-renovation_GLOBAL.md — стартовая вертикаль в скобках.
        (
            "> Тестовый файл. Сфера 99: `testsphere` — Ремонт и строительство "
            "(стартовая вертикаль).",
            "Ремонт и строительство",
        ),
    ],
)
def test_parse_file_strips_author_note_in_parens_from_sphere_name(
    tmp_path: Path, header_line: str, expected_name: str
) -> None:
    """Дефект прод (12.09): авторская пометка в скобках («архетип сделки
    sale, док 24», «единственная категория …», «стартовая вертикаль») —
    заметка для ревью, не часть показываемого имени сферы — вычищается
    парсером, не только руками в данных."""
    body = _MINIMAL_SPHERE_FILE.replace(
        "> Тестовый файл П-03. Сфера 99: `testsphere` — Тестовая сфера.", header_line
    )
    path = _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", body)
    parsed = parse_file(path)
    assert parsed.sphere_name == expected_name


def test_parse_file_sphere_name_without_parens_is_unchanged(tmp_path: Path) -> None:
    """Имя без скобок (обычный случай, 15 из 18 файлов) парсер не трогает."""
    path = _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)
    parsed = parse_file(path)
    assert parsed.sphere_name == "Тестовая сфера"


def test_parse_file_does_not_import_shablon_headed_tables_as_items(tmp_path: Path) -> None:
    """Заголовок «шаблон» вместо «категория» — блок социальных актов
    (CL-other_GLOBAL.md §2), НЕ сфера (docstring файла). Парсер такие
    таблицы намеренно не читает как пункты чек-листа сферы."""
    path = _write_sphere_file(tmp_path, "CL-social_like_GLOBAL.md", _SOCIAL_LIKE_FILE)
    parsed = parse_file(path)
    assert parsed.items == ()


def test_parse_file_strips_jurisdiction_marker_and_sets_flag(tmp_path: Path) -> None:
    """ADR-081 доп. 2026-08-12: «[Л]»/«[L]» — из markdown НЕ убирается
    (авторский конвент), но парсер вычищает его из `description` и
    выставляет `is_jurisdiction_sensitive`; пункт без маркера — флаг
    остаётся `False`, текст не трогается."""
    path = _write_sphere_file(tmp_path, "CL-testjuris_GLOBAL.md", _JURISDICTION_MARKER_FILE)
    parsed = parse_file(path)

    by_code = {item.code: item for item in parsed.items}
    assert by_code["work.1"].is_jurisdiction_sensitive is False
    assert by_code["work.1"].description == "Обычный пункт без маркера"

    assert by_code["work.2"].is_jurisdiction_sensitive is True
    assert by_code["work.2"].description == "Пункт со страновой реалией"
    assert "[Л]" not in by_code["work.2"].description

    assert by_code["work.3"].is_jurisdiction_sensitive is True
    assert by_code["work.3"].description == "Пункт с латинским маркером"
    assert "[L]" not in by_code["work.3"].description


def test_import_sets_is_jurisdiction_sensitive_and_second_run_stays_no_op(
    tmp_path: Path,
) -> None:
    _write_sphere_file(tmp_path, "CL-testjuris_GLOBAL.md", _JURISDICTION_MARKER_FILE)
    report = services.import_checklists(tmp_path)
    assert report.spheres[0].items_created == 3

    item1 = ChecklistTemplateItem.objects.get(slug="testjuris.cat1.work.1")
    item2 = ChecklistTemplateItem.objects.get(slug="testjuris.cat1.work.2")
    assert item1.is_jurisdiction_sensitive is False
    assert item2.is_jurisdiction_sensitive is True
    assert "[Л]" not in item2.description

    before_ids = set(ChecklistTemplateItem.objects.values_list("id", flat=True))
    report2 = services.import_checklists(tmp_path)
    sphere_report2 = report2.spheres[0]
    assert sphere_report2.items_created == 0
    assert sphere_report2.items_new_version == 0
    assert sphere_report2.items_unchanged == 3
    assert set(ChecklistTemplateItem.objects.values_list("id", flat=True)) == before_ids


def test_parse_file_missing_separator_row_raises() -> None:
    broken = _MINIMAL_SPHERE_FILE.replace("|---|---|---|---|---|---|\n", "", 1)
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        path = _write_sphere_file(Path(tmp), "CL-testsphere_GLOBAL.md", broken)
        with pytest.raises(ChecklistMarkdownError):
            parse_file(path)


def test_import_creates_items_sphere_and_material_link(tmp_path: Path) -> None:
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)

    report = services.import_checklists(tmp_path)

    assert len(report.spheres) == 1
    sphere_report = report.spheres[0]
    assert sphere_report.sphere_code == "testsphere"
    assert sphere_report.items_created == 2
    assert sphere_report.materials_created == 1
    assert sphere_report.unresolved_material_refs == ()

    sphere = Sphere.objects.get(code="testsphere")
    assert sphere.name_i18n == {"ru": "Тестовая сфера"}

    item1 = ChecklistTemplateItem.objects.get(slug="testsphere.cat1.work.1")
    assert item1.is_current is True
    assert item1.version == 1
    assert item1.measurable_criterion == item1.description  # GLOBAL: текст = критерий
    assert item1.check_method == "осмотр"
    assert item1.photo_required is True
    assert item1.is_default is True

    material = MaterialCatalogItem.objects.get(code="testsphere_cat1_testovyy_material")
    item2 = ChecklistTemplateItem.objects.get(slug="testsphere.cat1.work.2")
    assert item1.catalog_item_id == material.id
    assert item2.catalog_item_id == material.id


def test_import_is_idempotent_second_run_is_no_op(tmp_path: Path) -> None:
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)
    services.import_checklists(tmp_path)

    before_ids = set(ChecklistTemplateItem.objects.values_list("id", flat=True))
    report = services.import_checklists(tmp_path)

    sphere_report = report.spheres[0]
    assert sphere_report.items_created == 0
    assert sphere_report.items_new_version == 0
    assert sphere_report.items_unchanged == 2
    assert sphere_report.materials_created == 0
    assert sphere_report.materials_updated == 0
    assert sphere_report.materials_unchanged == 1
    assert set(ChecklistTemplateItem.objects.values_list("id", flat=True)) == before_ids


def test_editing_item_text_creates_new_version_and_keeps_old(tmp_path: Path) -> None:
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)
    services.import_checklists(tmp_path)

    edited = _MINIMAL_SPHERE_FILE.replace(
        "Первый пункт (текст версии 1)", "Первый пункт (текст версии 2, отредактирован)"
    )
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", edited)
    report = services.import_checklists(tmp_path)

    sphere_report = report.spheres[0]
    assert sphere_report.items_new_version == 1
    assert sphere_report.items_unchanged == 1  # work.2 не менялся

    versions = list(
        ChecklistTemplateItem.objects.filter(slug="testsphere.cat1.work.1").order_by("version")
    )
    assert [v.version for v in versions] == [1, 2]
    assert versions[0].is_current is False
    assert versions[1].is_current is True
    assert "версии 1" in versions[0].description
    assert "версии 2" in versions[1].description
    # slug — стабилен через версии (та же строка id меняется, slug — нет).
    assert versions[0].slug == versions[1].slug == "testsphere.cat1.work.1"


def test_superseded_version_not_returned_by_recommended_checklist_selector(tmp_path: Path) -> None:
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)
    services.import_checklists(tmp_path)
    edited = _MINIMAL_SPHERE_FILE.replace(
        "Первый пункт (текст версии 1)", "Первый пункт (текст версии 2, отредактирован)"
    )
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", edited)
    services.import_checklists(tmp_path)

    # Оба пункта привязаны к материалу (catalog_item), не к сфере напрямую
    # (базовых, «сферных» пунктов в этом фикстурном файле нет) — выборка
    # идёт через catalog_item_ids, не sphere_id.
    material = MaterialCatalogItem.objects.get(code="testsphere_cat1_testovyy_material")
    recs = selectors.recommended_checklist_template_items(
        catalog_item_ids=[material.id], sphere_id=None
    )
    descriptions = {r.description for r in recs}
    assert any("версии 2" in d for d in descriptions)
    assert not any("версии 1" in d for d in descriptions)
    assert recs.count() == 2  # work.1 (текущая версия) + work.2, не 3


def test_old_version_survives_reimport_of_unrelated_item(tmp_path: Path) -> None:
    """Правка ОДНОГО пункта не должна плодить версии у остальных —
    version у неизменённого work.2 остаётся 1."""
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)
    services.import_checklists(tmp_path)
    edited = _MINIMAL_SPHERE_FILE.replace(
        "Первый пункт (текст версии 1)", "Первый пункт (текст версии 2, отредактирован)"
    )
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", edited)
    services.import_checklists(tmp_path)

    work2 = ChecklistTemplateItem.objects.get(slug="testsphere.cat1.work.2")
    assert work2.version == 1
    assert work2.is_current is True


def test_export_checklists_i18n_keys_are_catalog_checklists_prefixed_and_current_only(
    tmp_path: Path,
) -> None:
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", _MINIMAL_SPHERE_FILE)
    services.import_checklists(tmp_path)
    edited = _MINIMAL_SPHERE_FILE.replace(
        "Первый пункт (текст версии 1)", "Первый пункт (текст версии 2, отредактирован)"
    )
    _write_sphere_file(tmp_path, "CL-testsphere_GLOBAL.md", edited)
    services.import_checklists(tmp_path)

    keys = services.export_checklists_i18n()
    relevant = {k: v for k, v in keys.items() if k.startswith("catalog.checklists.testsphere.")}
    assert set(relevant) == {
        "catalog.checklists.testsphere.cat1.work.1",
        "catalog.checklists.testsphere.cat1.work.2",
    }
    assert "версии 2" in relevant["catalog.checklists.testsphere.cat1.work.1"]
    # Ручной сид (slug="") не участвует в экспорте.
    assert all(k != "catalog.checklists." for k in keys)


@pytest.mark.skipif(
    not _REPO_CHECKLISTS_DIR.is_dir(), reason="docs/content/checklists недоступен из этого чекаута"
)
def test_real_checklists_directory_covers_all_seventeen_spheres_with_no_unresolved_refs() -> None:
    """Приёмка П-03: реальные docs/content/checklists/CL-*_GLOBAL.md
    импортируются без ошибок разметки, покрывают все 17 сфер + other, и
    каждая ссылка материала на пункт чек-листа разрешается."""
    report = services.import_checklists(_REPO_CHECKLISTS_DIR)

    covered = {s.sphere_code for s in report.spheres}
    assert covered >= _SEVENTEEN_SPHERES
    assert "other" in covered
    assert "social" not in covered  # social — не сфера, файла CL-social_*.md нет

    for sphere_report in report.spheres:
        assert sphere_report.items_created > 0, sphere_report.sphere_code
        assert sphere_report.unresolved_material_refs == (), sphere_report.sphere_code

    assert Sphere.objects.filter(code__in=_SEVENTEEN_SPHERES).count() == len(_SEVENTEEN_SPHERES)


@pytest.mark.skipif(
    not _REPO_CHECKLISTS_DIR.is_dir(), reason="docs/content/checklists недоступен из этого чекаута"
)
def test_real_checklists_item_count_matches_reconciled_index_total() -> None:
    """ADR-081 доп. 2026-08-12: 00_индекс.md §1 сноска ¹ — 1378 записей
    (1393 заявленных в плане минус 15 актов social, вне импорта
    архитектурно, минус 1 снятый лишний пункт после починки разметки
    CL-sales_GLOBAL.md). Ни один текст не содержит «[Л]»/«[L]» — маркер
    вычищен парсером в структурный флаг."""
    services.import_checklists(_REPO_CHECKLISTS_DIR)

    current_items = ChecklistTemplateItem.objects.filter(is_current=True).exclude(slug="")
    assert current_items.count() == 1378
    assert current_items.filter(is_jurisdiction_sensitive=True).count() == 23

    for description in current_items.values_list("description", flat=True):
        assert "[Л]" not in description
        assert "[L]" not in description

    # CL-sales_GLOBAL.md: маркер «пишется сторонами» категории `sales.other`
    # был размечен кодом `inspection.3` вместо `other` — не пропускался
    # парсером и заводил лишний пункт. Разметка исправлена.
    assert not ChecklistTemplateItem.objects.filter(slug="sales.other.inspection.3").exists()
    sales_items = ChecklistTemplateItem.objects.filter(is_current=True, slug__startswith="sales.")
    assert sales_items.count() == 40


@pytest.mark.skipif(
    not _REPO_CHECKLISTS_DIR.is_dir(), reason="docs/content/checklists недоступен из этого чекаута"
)
def test_checklist_slugs_use_education_not_legacy_tutoring_code() -> None:
    """chore/sphere-dedup: слаги чек-листов образования собираются из
    контентного трека П-03 (`CL-education_GLOBAL.md`, код `education`) —
    сид-заглушка Э4.1 (`tutoring`, migration 0006) их не задевает, слаг
    присваивается один раз при импорте и дальше не меняется (ADR-081)."""
    services.import_checklists(_REPO_CHECKLISTS_DIR)
    keys = services.export_checklists_i18n()
    education_keys = [k for k in keys if k.startswith("catalog.checklists.education.")]
    assert education_keys  # пункты сферы education реально есть
    assert not any(k.startswith("catalog.checklists.tutoring.") for k in keys)


_L10N_PACKS_DIR = Path(__file__).resolve().parents[4] / "l10n" / "packs"


@pytest.mark.skipif(not _L10N_PACKS_DIR.is_dir(), reason="l10n/packs недоступен из этого чекаута")
def test_l10n_packs_use_education_sphere_code_not_tutoring() -> None:
    """chore/sphere-dedup: «l10n-пакеты используют код education — сверить».
    Все языковые пакеты уже используют `catalog.spheres.education`
    (ключ), не `tutoring` — сверка тестом, не «на глаз»."""
    pack_files = sorted(_L10N_PACKS_DIR.glob("*.json"))
    assert pack_files  # каталог не пуст — сверка реально что-то проверяет

    for pack_file in pack_files:
        pack = json.loads(pack_file.read_text(encoding="utf-8"))
        spheres = pack.get("catalog", {}).get("spheres", {})
        assert "tutoring" not in spheres, pack_file.name
        assert "education" in spheres, pack_file.name
