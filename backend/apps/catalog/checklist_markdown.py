"""Парсер `docs/content/checklists/CL-*_GLOBAL.md` (П-03, ADR-081) — чистые
функции без обращений к ORM/БД: вход markdown-текст, выход dataclass'ы.
Оркестрация импорта (upsert в ORM, версионирование) — `apps.catalog.services.
import_checklists`, эта операция намеренно чистая и переиспользуема
(`export_checklists_i18n` тоже читает эти же файлы через тот же парсер).

Формат файлов зафиксирован `docs/content/checklists/00_индекс.md` §2 и
докстрингом `CL-renovation_GLOBAL.md` §0 «Формат и маппинг на модель
данных» — парсер следует ИМ, не изобретает свой формат:

- Таблица пунктов чек-листа — заголовок
  `| категория | код пункта | формулировка | как проверить | фото | дефолт |`
  (в блоке социальных договоров `CL-other_GLOBAL.md` первая колонка
  называется «шаблон» — та же позиция, другое имя; такие таблицы парсер
  сознательно пропускает, см. `_CHECKLIST_HEADER_FIRST_COL_ALLOWED` —
  `social.*` не сфера, тек-спека это подтверждает докстрингом самого файла,
  импорт чек-листов сфер эту секцию не касается).
- Таблица материалов — заголовок
  `| категория | позиция | единица | правило цены | связанные пункты чек-листа |`.
- Строка `<категория> | other | ...` в таблице пунктов — маркер «пишется
  сторонами» (00_индекс.md §3 п.1), не реальный пункт — пропускается.
- Строка материалов с позицией `Прочее (свободная позиция)` — маркер
  свободного ввода, не позиция каталога — пропускается.
- «Связанные пункты чек-листа» — `<категория>: код1, код2–код3; код4` —
  категория действует до следующего явного `<категория>:`; диапазон
  `base.N–M` (тире или EN DASH) разворачивается в `base.N..base.M`.
- Инлайн-маркер «[Л]» в формулировке (кириллица; допускался и вариант
  «[L]», латиницей) — страновая реалия пункта (`00_индекс.md` §2
  «GLOBAL-правила»: «страновые реалии — пометка [Л]»). В markdown НЕ
  трогается — авторский конвент для ревью и будущих правок остаётся как
  есть; парсер вычищает маркер из `description` и выставляет
  `ParsedChecklistItem.is_jurisdiction_sensitive` (ADR-081, доп.
  2026-08-12).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_FILENAME_RE = re.compile(r"^CL-(?P<code>[a-z_]+)_GLOBAL\.md$")
_SPHERE_NAME_RE = re.compile(
    r"Сфера\s+\S+:\s*`[a-z_]+`\s*—\s*(?P<name>[^\n]+?)\.\s*$", re.MULTILINE
)
# Скобка в шапке файла после названия сферы — ВСЕГДА авторская пометка для
# ревью (архетип сделки, стартовая вертикаль, оговорка про подкатегории),
# не часть показываемого имени: см. CL-sales_GLOBAL.md «Продажи (архетип
# сделки sale, док 24)», CL-other_GLOBAL.md «Прочее (единственная категория
# `other.other`) + блок …», CL-renovation_GLOBAL.md «Ремонт и строительство
# (стартовая вертикаль)». Дефект прод (12.09): такая пометка утекла в
# `Sphere.name_i18n` через `_import_sphere_file` — вырезаем всё начиная с
# первой открывающей скобки.

_CHECKLIST_HEADER = "| категория | код пункта | формулировка | как проверить | фото | дефолт |"
_MATERIALS_HEADER = "| категория | позиция | единица | правило цены | связанные пункты чек-листа |"
_SEPARATOR_RE = re.compile(r"^\|[-:\s|]+\|$")
_FREE_MATERIAL_POSITION = "Прочее (свободная позиция)"
_OTHER_CODE = "other"

_CODE_RANGE_RE = re.compile(r"^([a-zA-Z_]+)\.(\d+)[–-](\d+)$")
_CATEGORY_PREFIX_RE = re.compile(r"^([a-z_0-9]+):\s*(.+)$")

# «[Л]» (кириллица) / «[L]» (латиница) — маркер страновой реалии
# (00_индекс.md §2, ADR-081 доп. 2026-08-12); съедает пробел перед
# скобкой, чтобы не оставлять двойной пробел после вычистки.
_JURISDICTION_MARKER_RE = re.compile(r"\s*\[[ЛL]\]")


class ChecklistMarkdownError(ValueError):
    """Файл не соответствует формату `00_индекс.md` §2 — импорт этого файла
    останавливается (частичный импорт одного файла хуже честной ошибки)."""


@dataclass(frozen=True)
class ParsedChecklistItem:
    category: str
    code: str
    description: str
    check_method: str  # "" — метод не указан ("—" в таблице)
    photo_required: bool
    is_default: bool
    is_jurisdiction_sensitive: bool  # был инлайн-маркер «[Л]»/«[L]», уже вычищен из description
    order: int


@dataclass(frozen=True)
class ParsedMaterial:
    category: str
    position: str
    unit: str
    price_rule: str
    linked_refs: tuple[tuple[str, str], ...]  # (category, code) уже развёрнутые диапазоны
    order: int


@dataclass(frozen=True)
class ParsedSphereFile:
    sphere_code: str
    sphere_name: str
    source_file: str
    items: tuple[ParsedChecklistItem, ...]
    materials: tuple[ParsedMaterial, ...]


def _strip_author_note(raw_name: str) -> str:
    """Обрезает имя сферы по первой открывающей скобке — всё дальше
    (включая саму скобку) авторская пометка, не часть имени (см. коммент
    у `_SPHERE_NAME_RE`). Имя без скобок возвращается как есть."""
    return raw_name.split("(", 1)[0].strip()


def sphere_code_from_filename(filename: str) -> str:
    match = _FILENAME_RE.match(filename)
    if not match:
        raise ChecklistMarkdownError(
            f"{filename!r}: имя файла не соответствует шаблону CL-<сфера>_GLOBAL.md"
        )
    return match.group("code")


def iter_checklist_files(checklists_dir: Path) -> list[Path]:
    """Все `CL-*_GLOBAL.md` в каталоге, отсортированы по имени (стабильный
    порядок отчёта импорта); `00_индекс.md` под шаблон не подпадает —
    пропускается сам по себе."""
    return sorted(p for p in checklists_dir.glob("CL-*_GLOBAL.md") if p.is_file())


def parse_file(path: Path) -> ParsedSphereFile:
    text = path.read_text(encoding="utf-8")
    sphere_code = sphere_code_from_filename(path.name)
    name_match = _SPHERE_NAME_RE.search(text)
    sphere_name = _strip_author_note(name_match.group("name")) if name_match else sphere_code

    items: list[ParsedChecklistItem] = []
    materials: list[ParsedMaterial] = []
    lines = text.splitlines()
    i = 0
    item_order = 0
    material_order = 0
    while i < len(lines):
        line = lines[i].strip()
        if line == _CHECKLIST_HEADER:
            rows, i = _consume_table(lines, i)
            for row in rows:
                if len(row) != 6:
                    continue  # разметка нарушена — строка не мапится, пропуск
                category, code, description, method_raw, photo_raw, default_raw = row
                if code == _OTHER_CODE:
                    continue  # маркер «пишется сторонами» (00_индекс.md §3 п.1)
                is_jurisdiction_sensitive = bool(_JURISDICTION_MARKER_RE.search(description))
                description = _JURISDICTION_MARKER_RE.sub("", description).strip()
                items.append(
                    ParsedChecklistItem(
                        category=category,
                        code=code,
                        description=description,
                        check_method="" if method_raw in ("—", "-", "") else method_raw,
                        photo_required=photo_raw.strip() == "да",
                        is_default=default_raw.strip() == "да",
                        is_jurisdiction_sensitive=is_jurisdiction_sensitive,
                        order=item_order,
                    )
                )
                item_order += 1
            continue
        if line == _MATERIALS_HEADER:
            rows, i = _consume_table(lines, i)
            for row in rows:
                if len(row) != 5:
                    continue
                category, position, unit, price_rule, refs_raw = row
                if position == _FREE_MATERIAL_POSITION:
                    continue  # свободный ввод, не позиция каталога
                materials.append(
                    ParsedMaterial(
                        category=category,
                        position=position,
                        unit=unit,
                        price_rule=price_rule,
                        linked_refs=tuple(_parse_linked_refs(refs_raw, default_category=category)),
                        order=material_order,
                    )
                )
                material_order += 1
            continue
        i += 1

    return ParsedSphereFile(
        sphere_code=sphere_code,
        sphere_name=sphere_name,
        source_file=path.name,
        items=tuple(items),
        materials=tuple(materials),
    )


def _consume_table(lines: list[str], header_index: int) -> tuple[list[list[str]], int]:
    """header_index указывает на строку заголовка; возвращает (строки-данные,
    индекс первой строки ПОСЛЕ таблицы). Строка-разделитель `|---|...` —
    обязательна сразу после заголовка (формат `00_индекс.md`, все файлы)."""
    i = header_index + 1
    if i >= len(lines) or not _SEPARATOR_RE.match(lines[i].strip()):
        raise ChecklistMarkdownError(
            f"строка {i + 1}: ожидалась разделительная строка таблицы (|---|...|)"
        )
    i += 1
    rows: list[list[str]] = []
    while i < len(lines) and lines[i].strip().startswith("|"):
        rows.append(_split_row(lines[i]))
        i += 1
    return rows, i


def _split_row(line: str) -> list[str]:
    stripped = line.strip().strip("|")
    return [cell.strip() for cell in stripped.split("|")]


def _parse_linked_refs(raw: str, *, default_category: str) -> list[tuple[str, str]]:
    raw = raw.strip()
    if raw in ("", "—", "-"):
        return []
    result: list[tuple[str, str]] = []
    current_category = default_category
    for segment in raw.split(";"):
        segment = segment.strip()
        if not segment:
            continue
        prefix_match = _CATEGORY_PREFIX_RE.match(segment)
        if prefix_match:
            current_category = prefix_match.group(1)
            codes_part = prefix_match.group(2)
        else:
            codes_part = segment
        for code_raw in codes_part.split(","):
            code_raw = code_raw.strip()
            if code_raw:
                result.extend(_expand_code_range(code_raw, current_category))
    return result


def _expand_code_range(code_raw: str, category: str) -> list[tuple[str, str]]:
    match = _CODE_RANGE_RE.match(code_raw)
    if not match:
        return [(category, code_raw)]
    base, start, end = match.group(1), int(match.group(2)), int(match.group(3))
    return [(category, f"{base}.{n}") for n in range(start, end + 1)]
