#!/usr/bin/env python3
"""Сливает юр-документы платформы из `docs/legal/<code>/` (privacy.md,
terms.md, notice.md — staging переводчиков, читаемый и диффируемый markdown)
в `l10n/packs/<code>.json` как `legal.privacy` / `legal.tos` /
`legal.document_notice`, не трогая остальные namespace пакета.

Тот же приём, что `merge_checklists.py` (ADR-083): `LocalePack` — одна строка
на locale с одним `pack_version`/`checksum` на пакет ЦЕЛИКОМ (ADR-077), а
`apps.l10n.services.import_pack` на обновлении делает полную замену
`content`, не merge. Поэтому второй независимый источник на ту же locale
несовместим с деплой-циклом — слияние происходит на уровне ФАЙЛОВ, до
коммита, а в прод едет по-прежнему один файл на язык
(`import_l10n_pack` из `.github/workflows/deploy-staging.yml`, без правок в нём).

Почему документы лежат в `docs/legal/`, а не сразу строками в пакете:
юр-текст ревьюится и правится как ТЕКСТ (владелец, юр-трек Ю-23), а не как
JSON-значение с экранированными переводами строк; markdown-файл даёт
осмысленный `git diff` по абзацам. Пакет — транспорт, `docs/legal/` —
источник истины.

Использование:
    python3 l10n/merge_legal.py                 # все docs/legal/<code>/
    python3 l10n/merge_legal.py --check         # только валидация, без записи
    python3 l10n/merge_legal.py es de           # конкретные языки (смоук)

Валидация — до любой записи, по каждому языку независимо (отказ по одному
языку не трогает файловую систему и не мешает обработать остальные):
все три файла на месте и непусты; ровно один `# ` заголовок; число `## `
разделов и число строк markdown-таблиц совпадает с эталоном `en` (защита от
обрезанного машинного перевода — самая частая поломка контентной волны);
шапка несёт номер версии эталона; `notice.md` — один абзац; нет
непереведённых маркеров-заглушек.

Идемпотентность: если все три значения в пакете уже равны вливаемым — no-op,
`pack_version` не растёт. Иначе `pack_version` = текущий + 1 (читается из
файла пакета, не хардкодится)."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LEGAL_DIR = _REPO_ROOT / "docs" / "legal"
DEFAULT_PACKS_DIR = _REPO_ROOT / "l10n" / "packs"

# Эталон структуры — канонический (authoritative) язык документов.
REFERENCE_LOCALE = "en"

# Файл документа → ключ в namespace `legal` пакета. `tos` — историческое имя
# ключа из схемы пакета (l10n/README.md), файл называется terms.md по имени
# документа («Terms of Service»), переименовывать ключ пакета ради этого не
# стоит: он уже описан в README и читается `selectors.get_legal_text`.
DOC_FILES: dict[str, str] = {
    "privacy.md": "privacy",
    "terms.md": "tos",
    "notice.md": "document_notice",
}

# Заглушки, которые не должны доехать до прода в юр-тексте. Матч
# РЕГИСТРОЗАВИСИМЫЙ и по границам слова: строчное «todo» — обычное слово в
# испанском/итальянском/португальском («todos los datos», «per il resto»),
# а нечувствительный к регистру поиск подстроки заваливал бы на нём каждый
# романский перевод. Реальная заглушка переводчика всегда в верхнем регистре.
_PLACEHOLDER_MARKERS = ("TODO", "TBD", "XXX", "FIXME", "LOREM IPSUM", "[Л]", "[L]")
_PLACEHOLDER_RE = re.compile(
    "|".join(rf"\b{re.escape(m)}\b" if m[0].isalpha() else re.escape(m) for m in _PLACEHOLDER_MARKERS)
)

_H1_RE = re.compile(r"^# ", re.MULTILINE)
_H2_RE = re.compile(r"^## ", re.MULTILINE)
_TABLE_ROW_RE = re.compile(r"^\|", re.MULTILINE)
# Адреса ссылок и e-mail — то, что перевод не имеет права менять: подменённая
# ссылка в юр-документе ведёт человека не туда, куда обещает текст рядом с ней,
# и «косметическая» опечатка тут — уже юридическая проблема. Реальный случай на
# волне: в одном переводе ссылка «myaccount.google.com/permissions» получила
# адрес политики Google API.
_URL_RE = re.compile(r"\]\((https?://[^)\s]+)\)")
# Только ASCII и домен по частям, без дефисов в метках. Два реальных промаха
# более наивного варианта (`[\w.+-]+@[\w-]+\.[\w.]+`) на волне переводов:
#   - жадная точка в хвосте втягивала точку конца предложения
#     («…@gmail.com.»), и тайский, где точки в конце фразы нет, «терял» адрес;
#   - `\w` включает не-латиницу, и грузинское «…@gmail.com-ზე» (послелог
#     приклеивается к адресу — норма языка, а не опечатка) читалось как ДРУГОЙ
#     адрес. Сверять надо сам адрес, а не то, как язык его склеивает с текстом.
_EMAIL_RE = re.compile(r"[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9]+)+")
# «**Version:** 1.0 · Effective …» / «**Версия:** 1.0 · Действует с …» —
# сверяем только сам номер, слово-подпись у каждого языка своё.
_VERSION_RE = re.compile(r"\b(\d+\.\d+)\b")


class MergeError(Exception):
    """Отказ по одному языку — валидация до записи, без частичных изменений."""


@dataclass(frozen=True)
class DocShape:
    """Структурный отпечаток документа — то, что обязано совпасть у перевода
    с эталоном. Смысл не проверяем (машинный перевод), но обрезанный текст,
    потерянную таблицу или съеденный раздел так поймать можно."""

    h2_count: int
    table_rows: int
    version: str | None
    urls: frozenset[str]
    emails: frozenset[str]


@dataclass(frozen=True)
class MergeResult:
    locale: str
    status: str  # "merged" | "skip" | "error"
    detail: str
    new_version: int | None = None


def shape_of(text: str) -> DocShape:
    head = "\n".join(text.splitlines()[:10])
    version_match = _VERSION_RE.search(head)
    return DocShape(
        h2_count=len(_H2_RE.findall(text)),
        table_rows=len(_TABLE_ROW_RE.findall(text)),
        version=version_match.group(1) if version_match else None,
        urls=frozenset(_URL_RE.findall(text)),
        emails=frozenset(_EMAIL_RE.findall(text)),
    )


def discover_locales(legal_dir: Path) -> list[str]:
    """Подкаталоги `docs/legal/` — по одному на язык. Служебные (имя с `_`
    или `.`) игнорируются, как и файлы верхнего уровня (README.md)."""
    return sorted(
        p.name
        for p in legal_dir.iterdir()
        if p.is_dir() and not p.name.startswith(("_", "."))
    )


def load_reference(legal_dir: Path) -> dict[str, DocShape]:
    """Структурные отпечатки эталона (`en`) — по файлу документа."""
    shapes: dict[str, DocShape] = {}
    for filename in DOC_FILES:
        path = legal_dir / REFERENCE_LOCALE / filename
        if not path.is_file():
            raise MergeError(f"эталон не найден: {path}")
        shapes[filename] = shape_of(path.read_text(encoding="utf-8"))
    return shapes


def _validate_doc(
    locale: str, filename: str, text: str, reference: DocShape
) -> None:
    where = f"docs/legal/{locale}/{filename}"

    if not text.strip():
        raise MergeError(f"{where}: пустой файл")

    placeholder = _PLACEHOLDER_RE.search(text)
    if placeholder:
        raise MergeError(f"{where}: заглушка {placeholder.group(0)!r} не заменена переводом")

    if filename == "notice.md":
        # Оговорка об основной версии — один абзац, не документ: без
        # заголовков и без переводов строки внутри абзаца.
        if _H1_RE.search(text) or _H2_RE.search(text):
            raise MergeError(f"{where}: оговорка — один абзац, без заголовков")
        if len([line for line in text.strip().splitlines() if line.strip()]) != 1:
            raise MergeError(f"{where}: оговорка — ровно один абзац одной строкой")
        return

    h1_count = len(_H1_RE.findall(text))
    if h1_count != 1:
        raise MergeError(f"{where}: ожидался ровно один заголовок '# ', найдено {h1_count}")

    actual = shape_of(text)
    if actual.h2_count != reference.h2_count:
        raise MergeError(
            f"{where}: разделов '## ' {actual.h2_count}, у эталона "
            f"{REFERENCE_LOCALE} — {reference.h2_count} (обрезанный перевод?)"
        )
    if actual.table_rows != reference.table_rows:
        raise MergeError(
            f"{where}: строк таблиц {actual.table_rows}, у эталона "
            f"{REFERENCE_LOCALE} — {reference.table_rows} (потерянная таблица?)"
        )
    if reference.version is not None and actual.version != reference.version:
        raise MergeError(
            f"{where}: версия в шапке {actual.version!r}, у эталона "
            f"{REFERENCE_LOCALE} — {reference.version!r}"
        )
    if actual.urls != reference.urls:
        raise MergeError(
            f"{where}: адреса ссылок расходятся с эталоном {REFERENCE_LOCALE} — "
            f"лишние {sorted(actual.urls - reference.urls)}, "
            f"пропали {sorted(reference.urls - actual.urls)}"
        )
    if actual.emails != reference.emails:
        raise MergeError(
            f"{where}: адреса e-mail расходятся с эталоном {REFERENCE_LOCALE} — "
            f"лишние {sorted(actual.emails - reference.emails)}, "
            f"пропали {sorted(reference.emails - actual.emails)}"
        )


def read_documents(
    legal_dir: Path, locale: str, reference: dict[str, DocShape]
) -> dict[str, str]:
    """`{ключ пакета: текст}` — все три документа языка, после валидации."""
    documents: dict[str, str] = {}
    for filename, pack_key in DOC_FILES.items():
        path = legal_dir / locale / filename
        if not path.is_file():
            raise MergeError(f"docs/legal/{locale}/{filename}: файл не найден")
        text = path.read_text(encoding="utf-8")
        _validate_doc(locale, filename, text, reference[filename])
        documents[pack_key] = text.strip() + "\n"
    return documents


def merge_one(
    locale: str, legal_dir: Path, packs_dir: Path, reference: dict[str, DocShape], *, check_only: bool
) -> MergeResult:
    pack_path = packs_dir / f"{locale}.json"
    if not pack_path.is_file():
        return MergeResult(locale, "error", f"целевой пакет не найден: {pack_path}")
    try:
        with pack_path.open(encoding="utf-8") as f:
            pack_data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return MergeResult(locale, "error", f"не удалось прочитать {pack_path}: {exc}")

    try:
        documents = read_documents(legal_dir, locale, reference)
    except (MergeError, OSError) as exc:
        return MergeResult(locale, "error", str(exc))

    legal = pack_data.get("legal")
    if legal is not None and not isinstance(legal, dict):
        return MergeResult(locale, "error", f"{pack_path}: legal — не объект")

    existing = legal or {}
    if all(existing.get(key) == value for key, value in documents.items()):
        return MergeResult(locale, "skip", "юр-документы уже актуальны — без изменений")

    if check_only:
        changed = [key for key, value in documents.items() if existing.get(key) != value]
        return MergeResult(locale, "merged", f"валиден, к обновлению: {', '.join(sorted(changed))}")

    pack_data.setdefault("legal", {}).update(documents)
    new_version = int(pack_data["pack_version"]) + 1
    pack_data["pack_version"] = new_version

    with pack_path.open("w", encoding="utf-8") as f:
        json.dump(pack_data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    return MergeResult(locale, "merged", f"pack_version → {new_version}", new_version)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "locales",
        nargs="*",
        help="Коды языков (по умолчанию — все подкаталоги --legal-dir)",
    )
    parser.add_argument("--legal-dir", type=Path, default=DEFAULT_LEGAL_DIR)
    parser.add_argument("--packs-dir", type=Path, default=DEFAULT_PACKS_DIR)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Только валидация структуры — ничего не записывать (pack_version не растёт)",
    )
    args = parser.parse_args(argv)

    try:
        reference = load_reference(args.legal_dir)
    except (MergeError, OSError) as exc:
        print(f"ошибка чтения эталона {REFERENCE_LOCALE}: {exc}", file=sys.stderr)
        return 2

    locales = args.locales or discover_locales(args.legal_dir)
    if not locales:
        print(f"в {args.legal_dir} нет ни одного подкаталога языка", file=sys.stderr)
        return 2

    results = [
        merge_one(locale, args.legal_dir, args.packs_dir, reference, check_only=args.check)
        for locale in locales
    ]

    status_marker = {"merged": "OK", "skip": "skip", "error": "FAIL"}
    for r in results:
        print(f"[{status_marker[r.status]}] {r.locale}: {r.detail}")

    merged = sum(1 for r in results if r.status == "merged")
    skipped = sum(1 for r in results if r.status == "skip")
    errors = sum(1 for r in results if r.status == "error")
    verb = "валидно" if args.check else "слито"
    print(f"\nитого: {merged} {verb}, {skipped} без изменений, {errors} ошибок из {len(results)}")

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
