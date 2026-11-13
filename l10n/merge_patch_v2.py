#!/usr/bin/env python3
"""Сливает `errors` и `catalog.contract_types` из патча v2
(`<code>.patch-v2.json`, архив `porukam_patch-v2_errors-contract-types_
27-languages`) в `l10n/packs/<code>.json`, не трогая остальные namespace
пакета (`notifications`/`ui`/`legal`/`catalog.spheres`/`catalog.client_tree`).

Тот же приём и те же причины, что `l10n/merge_checklists.py` (см. его
докстринг): `apps.l10n.services.import_pack` на обновлении делает ПОЛНУЮ
замену `content`, не merge — два независимых источника на одну locale
(errors/contract_types готовятся отдельно от catalog.spheres/client_tree)
в этой схеме несовместимы на уровне `import_pack`. Слияние на уровне
ФАЙЛОВ, этап подготовки контента, оставляет `import_pack`/`LocalePack`/
деплой-цикл нетронутыми.

`en`/`ru` уже влиты отдельно (`chore/l10n-patch-v2`, `feat/l10n-error-texts`)
— `en.patch-v2.json` и `en.patch-v2.ORIGINAL-as-supplied.json` из этого
прогона исключаются явно (первый по коду locale, второй по маске имени:
не оканчивается на `.patch-v2.json`); `ru.patch-v2.json` в архиве нет
вообще (ru не входил в патч v2).

`_note` патча (importer provenance, не UI-текст, см. `PATCH_v2_notes.md`)
в целевой пакет НЕ переносится — тот же приём, что `merge_checklists.py`
(целевой пакет своего `_note` для errors/contract_types не ведёт).

Референс ключей/порядка (`errors` — 105, `catalog.contract_types` — 17,
«в порядке EN») — `l10n/packs/en.json`, читается на каждый прогон, не
хардкодится.

Использование:
    python3 l10n/merge_patch_v2.py                 # все <code>.patch-v2.json из --patch-dir
    python3 l10n/merge_patch_v2.py --patch-dir DIR  # другое расположение архива
    python3 l10n/merge_patch_v2.py DIR/de.patch-v2.json  # один файл (смоук)"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_L10N_DIR = Path(__file__).resolve().parent
DEFAULT_PACKS_DIR = _L10N_DIR / "packs"
DEFAULT_PATCH_DIR = Path(
    "/mnt/c/Users/trust/Downloads/porukam_patch-v2_errors-contract-types_27-languages"
)
PATCH_SUFFIX = ".patch-v2.json"

# en/ru вливаются отдельно от этого скрипта (см. докстринг модуля).
_EXCLUDED_LOCALES = frozenset({"en", "ru"})

_REQUIRED_PATCH_FIELDS = ("locale", "name", "rtl", "quality", "pack_version", "errors", "catalog")


class MergeError(Exception):
    """Отказ по одному файлу — валидация до записи, без частичных изменений."""


@dataclass(frozen=True)
class MergeResult:
    locale: str
    status: str  # "merged" | "skip" | "error"
    detail: str
    new_version: int | None = None


def discover_patch_files(patch_dir: Path) -> list[Path]:
    """Маска ровно `*.patch-v2.json` — `en.patch-v2.ORIGINAL-as-supplied.json`
    под неё структурно не попадает (не оканчивается на `.patch-v2.json`)."""
    return sorted(patch_dir.glob(f"*{PATCH_SUFFIX}"))


def load_reference(packs_dir: Path) -> tuple[list[str], list[str]]:
    """Ключи `errors`/`catalog.contract_types` из `l10n/packs/en.json`, в EN
    порядке — эталон и для набора ключей, и для порядка (не хардкод)."""
    en_path = packs_dir / "en.json"
    with en_path.open(encoding="utf-8") as f:
        en = json.load(f)
    errors_keys = list(en["errors"].keys())
    contract_types_keys = list(en["catalog"]["contract_types"].keys())
    return errors_keys, contract_types_keys


def _locale_from_filename(path: Path) -> str:
    name = path.name
    if not name.endswith(PATCH_SUFFIX):
        raise MergeError(f"{name}: ожидалось имя вида <code>{PATCH_SUFFIX}")
    return name[: -len(PATCH_SUFFIX)]


def _validate_and_extract(
    patch_path: Path,
    data: Any,
    *,
    reference_errors: list[str],
    reference_contract_types: list[str],
    pack_data: dict[str, Any],
    locale_from_name: str,
) -> tuple[dict[str, str], dict[str, str]]:
    if not isinstance(data, dict):
        raise MergeError(f"{patch_path.name}: ожидался JSON-объект")

    for field in _REQUIRED_PATCH_FIELDS:
        if field not in data:
            raise MergeError(f"{patch_path.name}: отсутствует поле шапки {field!r}")

    if data["locale"] != locale_from_name:
        raise MergeError(
            f"{patch_path.name}: locale в шапке ({data['locale']!r}) не совпадает "
            f"с кодом в имени файла ({locale_from_name!r})"
        )

    if data["rtl"] != pack_data.get("rtl"):
        raise MergeError(
            f"{patch_path.name}: rtl={data['rtl']!r} не совпадает с "
            f"l10n/packs/{locale_from_name}.json (rtl={pack_data.get('rtl')!r})"
        )

    errors = data["errors"]
    if not isinstance(errors, dict):
        raise MergeError(f"{patch_path.name}: errors должен быть объектом")
    if list(errors.keys()) != reference_errors:
        missing = set(reference_errors) - set(errors.keys())
        extra = set(errors.keys()) - set(reference_errors)
        if missing or extra:
            parts = []
            if missing:
                parts.append(f"не хватает {len(missing)} (напр. {sorted(missing)[:3]})")
            if extra:
                parts.append(f"лишние {len(extra)} (напр. {sorted(extra)[:3]})")
            raise MergeError(f"{patch_path.name}: errors — {'; '.join(parts)}")
        raise MergeError(f"{patch_path.name}: errors — набор ключей верный, но порядок не EN")

    catalog = data["catalog"]
    if not isinstance(catalog, dict) or not isinstance(catalog.get("contract_types"), dict):
        raise MergeError(f"{patch_path.name}: нет объекта catalog.contract_types")
    contract_types = catalog["contract_types"]
    if list(contract_types.keys()) != reference_contract_types:
        missing = set(reference_contract_types) - set(contract_types.keys())
        extra = set(contract_types.keys()) - set(reference_contract_types)
        if missing or extra:
            parts = []
            if missing:
                parts.append(f"не хватает {len(missing)} (напр. {sorted(missing)[:3]})")
            if extra:
                parts.append(f"лишние {len(extra)} (напр. {sorted(extra)[:3]})")
            raise MergeError(f"{patch_path.name}: catalog.contract_types — {'; '.join(parts)}")
        raise MergeError(
            f"{patch_path.name}: catalog.contract_types — набор ключей верный, но порядок не EN"
        )

    for label, mapping in (("errors", errors), ("catalog.contract_types", contract_types)):
        for key, value in mapping.items():
            if not isinstance(value, str) or not value.strip():
                raise MergeError(f"{patch_path.name}: {label}.{key} — пустое значение")

    return errors, contract_types


def merge_one(
    patch_path: Path,
    packs_dir: Path,
    reference_errors: list[str],
    reference_contract_types: list[str],
) -> MergeResult:
    try:
        locale = _locale_from_filename(patch_path)
    except MergeError as exc:
        return MergeResult(patch_path.name, "error", str(exc))

    if locale in _EXCLUDED_LOCALES:
        return MergeResult(locale, "skip", "вливается отдельной веткой, не этим скриптом")

    try:
        with patch_path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return MergeResult(locale, "error", f"не удалось прочитать {patch_path.name}: {exc}")

    pack_path = packs_dir / f"{locale}.json"
    if not pack_path.is_file():
        return MergeResult(
            locale, "skip", f"базового пакета нет ({pack_path.name}) — вольётся после B3-базы"
        )
    try:
        with pack_path.open(encoding="utf-8") as f:
            pack_data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return MergeResult(locale, "error", f"не удалось прочитать {pack_path}: {exc}")

    try:
        errors, contract_types = _validate_and_extract(
            patch_path,
            data,
            reference_errors=reference_errors,
            reference_contract_types=reference_contract_types,
            pack_data=pack_data,
            locale_from_name=locale,
        )
    except MergeError as exc:
        return MergeResult(locale, "error", str(exc))

    existing_errors = pack_data.get("errors")
    existing_contract_types = pack_data.get("catalog", {}).get("contract_types")
    if existing_errors == errors and existing_contract_types == contract_types:
        return MergeResult(locale, "skip", "errors/contract_types уже актуальны — без изменений")

    pack_data["errors"] = errors
    pack_data.setdefault("catalog", {})["contract_types"] = contract_types
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
        help="Конкретные <code>.patch-v2.json (по умолчанию — все под --patch-dir)",
    )
    parser.add_argument("--patch-dir", type=Path, default=DEFAULT_PATCH_DIR)
    parser.add_argument("--packs-dir", type=Path, default=DEFAULT_PACKS_DIR)
    args = parser.parse_args(argv)

    try:
        reference_errors, reference_contract_types = load_reference(args.packs_dir)
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        print(f"ошибка чтения референса {args.packs_dir / 'en.json'}: {exc}", file=sys.stderr)
        return 2

    files = args.files or discover_patch_files(args.patch_dir)
    if not files:
        print(f"маска *{PATCH_SUFFIX} не нашла ни одного файла в {args.patch_dir}", file=sys.stderr)
        return 2

    results = [
        merge_one(f, args.packs_dir, reference_errors, reference_contract_types) for f in files
    ]

    status_marker = {"merged": "OK", "skip": "skip", "error": "FAIL"}
    for r in results:
        print(f"[{status_marker[r.status]}] {r.locale}: {r.detail}")

    merged = sum(1 for r in results if r.status == "merged")
    skipped = sum(1 for r in results if r.status == "skip")
    errors_n = sum(1 for r in results if r.status == "error")
    print(
        f"\nитого: {merged} слито, {skipped} без изменений/skip, "
        f"{errors_n} ошибок из {len(results)}"
    )

    return 1 if errors_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
