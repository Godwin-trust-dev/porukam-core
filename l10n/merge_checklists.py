#!/usr/bin/env python3
"""Сливает переводы чек-листов из `l10n/checklists/<code>.checklists.json`
(частичный языковой пакет — шапка + `catalog.checklists`, staging для
переводчиков, П-03/ADR-081) в `l10n/packs/<code>.json` как namespace
`catalog.checklists`, не трогая остальные namespace пакета.

Почему отдельный скрипт, а не второй прогон `import_l10n_pack` по
`l10n/checklists/` в деплое (умерший план chore/l10n-checklists-image):
`LocalePack` — одна строка на locale, `pack_version`/`checksum` считаются
на пакет целиком (ADR-077), а `apps.l10n.services.import_pack` на
обновлении делает `existing.content = data` — ПОЛНУЮ замену, не merge.
Два независимых источника на одну locale в этой схеме несовместимы: либо
падение по версии, либо молчаливая потеря `errors`/`notifications`/`ui`/
`legal`. Слияние на уровне ФАЙЛОВ (этот скрипт, этап подготовки контента)
оставляет `import_pack`/`LocalePack`/деплой-цикл нетронутыми — в проде
по-прежнему один файл на locale = один pack_version = одна запись.

Вход — строго маска `*.checklists.json`; `_source.ru.json` под неё не
попадает по имени (это исходник для переводчиков — плоский
`{catalog.checklists.<slug>: RU-текст}`, регенерируется
`export_checklists_i18n`, не пакет).

Использование:
    python3 l10n/merge_checklists.py                  # все l10n/checklists/*.checklists.json
    python3 l10n/merge_checklists.py l10n/checklists/ru.checklists.json  # один файл (смоук)

Валидация — до любой записи, по каждому файлу независимо (отказ по одному
файлу не трогает файловую систему и не мешает обработать остальные):
локаль шапки = коду в имени файла; `rtl` шапки = `rtl` целевого пакета;
набор ключей `catalog.checklists` = набору ключей `_source.ru.json`
(ни лишних, ни недостающих); ни одно значение не содержит маркер
`[Л]`/`[L]` (ADR-081, дополнение 12.08 — снимается отдельным патч-проходом,
до этого файлы ЗАКОНОМЕРНО не проходят валидацию, это не баг скрипта);
ни одного пустого значения.

Идемпотентность: если `catalog.checklists` целевого пакета уже равен
вливаемому — no-op, `pack_version` не растёт. Иначе `pack_version` = текущий
+ 1 (читается из файла пакета, не хардкодится — независимо от того, кто и
сколько раз его уже бампал)."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_L10N_DIR = Path(__file__).resolve().parent
DEFAULT_CHECKLISTS_DIR = _L10N_DIR / "checklists"
DEFAULT_PACKS_DIR = _L10N_DIR / "packs"
CHECKLISTS_SUFFIX = ".checklists.json"

# ADR-081 доп. (12.08) — маркер юрисдикционно-чувствительного пункта,
# должен быть снят патч-проходом до перевода/слияния, не переведён как есть.
_UNCLEANED_MARKERS = ("[Л]", "[L]")

_REQUIRED_HEADER_FIELDS = ("locale", "name", "rtl", "quality", "pack_version", "catalog")


class MergeError(Exception):
    """Отказ по одному файлу — валидация до записи, без частичных изменений."""


@dataclass(frozen=True)
class MergeResult:
    locale: str
    status: str  # "merged" | "skip" | "error"
    detail: str
    new_version: int | None = None


def discover_checklists_files(checklists_dir: Path) -> list[Path]:
    """Маска ровно `*.checklists.json` — `_source.ru.json` (и любые прочие
    служебные файлы каталога) под неё структурно не попадают."""
    return sorted(checklists_dir.glob(f"*{CHECKLISTS_SUFFIX}"))


def load_source_keys(source_path: Path) -> set[str]:
    with source_path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise MergeError(f"{source_path}: ожидался JSON-объект {{ключ: текст}}")
    return set(data.keys())


def _locale_from_filename(path: Path) -> str:
    name = path.name
    if not name.endswith(CHECKLISTS_SUFFIX):
        raise MergeError(f"{name}: ожидалось имя вида <code>{CHECKLISTS_SUFFIX}")
    return name[: -len(CHECKLISTS_SUFFIX)]


def _validate_and_extract(
    checklists_path: Path,
    data: Any,
    *,
    source_keys: set[str],
    pack_data: dict[str, Any],
    locale_from_name: str,
) -> dict[str, str]:
    if not isinstance(data, dict):
        raise MergeError(f"{checklists_path.name}: ожидался JSON-объект")

    for field in _REQUIRED_HEADER_FIELDS:
        if field not in data:
            raise MergeError(f"{checklists_path.name}: отсутствует поле шапки {field!r}")

    if data["locale"] != locale_from_name:
        raise MergeError(
            f"{checklists_path.name}: locale в шапке ({data['locale']!r}) не совпадает "
            f"с кодом в имени файла ({locale_from_name!r})"
        )

    if data["rtl"] != pack_data.get("rtl"):
        raise MergeError(
            f"{checklists_path.name}: rtl={data['rtl']!r} не совпадает с "
            f"l10n/packs/{locale_from_name}.json (rtl={pack_data.get('rtl')!r})"
        )

    catalog = data["catalog"]
    if not isinstance(catalog, dict) or not isinstance(catalog.get("checklists"), dict):
        raise MergeError(f"{checklists_path.name}: нет объекта catalog.checklists")
    checklists = catalog["checklists"]

    actual_keys = set(checklists.keys())
    missing = source_keys - actual_keys
    extra = actual_keys - source_keys
    if missing or extra:
        parts = []
        if missing:
            parts.append(f"не хватает {len(missing)} (напр. {sorted(missing)[:3]})")
        if extra:
            parts.append(f"лишние {len(extra)} (напр. {sorted(extra)[:3]})")
        raise MergeError(
            f"{checklists_path.name}: набор ключей catalog.checklists расходится "
            f"с _source.ru.json — {'; '.join(parts)}"
        )

    for key, value in checklists.items():
        if not isinstance(value, str):
            raise MergeError(f"{checklists_path.name}: {key} — значение должно быть строкой")
        if not value.strip():
            raise MergeError(f"{checklists_path.name}: {key} — пустое значение")
        for marker in _UNCLEANED_MARKERS:
            if marker in value:
                raise MergeError(
                    f"{checklists_path.name}: {key} — маркер {marker!r} не вычищен "
                    "(нужен патч-проход ADR-081 доп. 12.08 до слияния)"
                )

    return checklists


def merge_one(checklists_path: Path, packs_dir: Path, source_keys: set[str]) -> MergeResult:
    try:
        locale = _locale_from_filename(checklists_path)
    except MergeError as exc:
        return MergeResult(checklists_path.name, "error", str(exc))

    try:
        with checklists_path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return MergeResult(locale, "error", f"не удалось прочитать {checklists_path.name}: {exc}")

    pack_path = packs_dir / f"{locale}.json"
    if not pack_path.is_file():
        return MergeResult(locale, "error", f"целевой пакет не найден: {pack_path}")
    try:
        with pack_path.open(encoding="utf-8") as f:
            pack_data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return MergeResult(locale, "error", f"не удалось прочитать {pack_path}: {exc}")

    try:
        checklists = _validate_and_extract(
            checklists_path,
            data,
            source_keys=source_keys,
            pack_data=pack_data,
            locale_from_name=locale,
        )
    except MergeError as exc:
        return MergeResult(locale, "error", str(exc))

    existing = pack_data.get("catalog", {}).get("checklists")
    if existing == checklists:
        return MergeResult(locale, "skip", "catalog.checklists уже актуален — без изменений")

    pack_data.setdefault("catalog", {})["checklists"] = checklists
    new_version = int(pack_data["pack_version"]) + 1
    pack_data["pack_version"] = new_version

    with pack_path.open("w", encoding="utf-8") as f:
        json.dump(pack_data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    return MergeResult(locale, "merged", f"pack_version → {new_version}", new_version)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "files",
        nargs="*",
        type=Path,
        help="Конкретные *.checklists.json (по умолчанию — все под --checklists-dir)",
    )
    parser.add_argument("--checklists-dir", type=Path, default=DEFAULT_CHECKLISTS_DIR)
    parser.add_argument("--packs-dir", type=Path, default=DEFAULT_PACKS_DIR)
    parser.add_argument(
        "--source",
        type=Path,
        default=None,
        help="_source.ru.json (по умолчанию — <checklists-dir>/_source.ru.json)",
    )
    args = parser.parse_args(argv)

    source_path = args.source or (args.checklists_dir / "_source.ru.json")
    try:
        source_keys = load_source_keys(source_path)
    except (MergeError, OSError, json.JSONDecodeError) as exc:
        print(f"ошибка чтения source {source_path}: {exc}", file=sys.stderr)
        return 2

    files = args.files or discover_checklists_files(args.checklists_dir)
    if not files:
        print(
            f"маска *{CHECKLISTS_SUFFIX} не нашла ни одного файла в {args.checklists_dir}",
            file=sys.stderr,
        )
        return 2

    results = [merge_one(f, args.packs_dir, source_keys) for f in files]

    status_marker = {"merged": "OK", "skip": "skip", "error": "FAIL"}
    for r in results:
        print(f"[{status_marker[r.status]}] {r.locale}: {r.detail}")

    merged = sum(1 for r in results if r.status == "merged")
    skipped = sum(1 for r in results if r.status == "skip")
    errors = sum(1 for r in results if r.status == "error")
    print(f"\nитого: {merged} слито, {skipped} без изменений, {errors} ошибок из {len(results)}")

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
