"""Долив недостающих ключей в `l10n/packs/<code>.json` (ADR-095).

Зачем отдельный скрипт рядом с `merge_patch_v2.py`/`merge_legal.py`: те
вливают ОЧЕРЕДНУЮ волну контента целиком (пакет от внешнего конвейера поверх пакета в
репозитории), а здесь — точечная досыпка ключей, которых не оказалось ни в
одном пакете, кроме ru/en: конвейер волнами их просто не заводил, и 27 из 29
языков молча жили на EN-фолбэке (docs/adr/ADR-095).

Главное свойство: НИКОГДА не перезаписывает существующее значение. Патч
может содержать ключ, который у части языков уже переведён (например
`milestone.accepted` есть у ar/fa/he и нет у остальных) — существующий текст
всегда старше и ближе к ревью носителем, чем то, что дольёт этот скрипт.

`pack_version` бампается ровно так же, как в `merge_checklists.py`/
`merge_legal.py`/`merge_patch_v2.py` (+1 от значения В ФАЙЛЕ, не хардкод), и
по той же причине: `import_l10n_pack` считает checksum по всему пакету КРОМЕ
`pack_version` (`apps.l10n.services._checksum`), поэтому «та же версия, другое
содержимое» — это `PackVersionConflictError`. В деплое это не «пакет не
обновился», а красный джоб: `.github/workflows/deploy-staging.yml` гоняет
импорт циклом с `|| exit 1`, так что первый же непобампанный пакет рушит
выкладку целиком, ДО `compose up` — релиз не выходит вообще. Идемпотентность
тоже как у соседей: ничего не добавили — версию не трогаем.

Запуск:
    python3 l10n/apply_pack_patch.py l10n/patches/<файл>.json [...]

Формат патча — те же неймспейсы, что у пакета, но сгруппированные по языку:

    {"de": {"errors": {"code": "..."},
            "notifications": {"topic": {"subject": "...", "body": "..."}}}}
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

PACKS = Path(__file__).resolve().parent / "packs"


def _merge(target: dict[str, Any], patch: dict[str, Any], path: str = "") -> list[str]:
    """Рекурсивный merge «только недостающее». Возвращает добавленные пути —
    вызывающая сторона печатает их, чтобы долив не был молчаливым."""
    added: list[str] = []
    for key, value in patch.items():
        here = f"{path}{key}"
        if isinstance(value, dict):
            node = target.get(key)
            if not isinstance(node, dict):
                if key in target:
                    # Скаляр там, где патч ждёт объект — расхождение схемы,
                    # молча затирать нельзя.
                    raise SystemExit(f"{here}: в пакете скаляр, в патче объект")
                node = {}
                target[key] = node
            added += _merge(node, value, f"{here}.")
        elif key not in target or target[key] in (None, ""):
            target[key] = value
            added.append(here)
    return added


def load_patch(paths: list[Path]) -> dict[str, dict[str, Any]]:
    """Несколько файлов патча -> один патч, сгруппированный по языку.

    Файлы складываются тем же «только недостающее» merge'ем, что и запись в
    пакет: патчи резались по объёму (errors отдельно, уведомления тремя
    кусками), пересечься ключами они не должны, а если пересеклись — выигрывает
    файл, названный первым, и правило «раньше = ближе к ревью» держится на всём
    пути."""
    patch: dict[str, dict[str, Any]] = {}
    for path in paths:
        chunk = json.loads(path.read_text(encoding="utf-8"))
        for locale, content in chunk.items():
            _merge(patch.setdefault(locale, {}), content)
    return patch


def apply_one(
    locale: str, content: dict[str, Any], packs_dir: Path
) -> tuple[list[str], int | None]:
    """Долив одного языка. Возвращает (добавленные пути, новый pack_version);
    `None` вместо версии — добавлять было нечего, файл не переписан."""
    path = packs_dir / f"{locale}.json"
    if not path.exists():
        raise SystemExit(f"нет пакета {path}")
    pack = json.loads(path.read_text(encoding="utf-8"))
    added = _merge(pack, content)
    if not added:
        return [], None
    new_version = int(pack["pack_version"]) + 1
    pack["pack_version"] = new_version
    path.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return added, new_version


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2

    patch = load_patch([Path(name) for name in argv])

    total = 0
    for locale, content in sorted(patch.items()):
        added, new_version = apply_one(locale, content, PACKS)
        if new_version is None:
            print(f"{locale:8} — всё уже на месте")
            continue
        total += len(added)
        print(f"{locale:8} +{len(added):3} ключей, pack_version -> {new_version}")
    print(f"итого добавлено: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
