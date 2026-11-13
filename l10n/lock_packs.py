"""`l10n/packs.lock.json` — слепок «pack_version + checksum» каждого пакета.

Зачем: импортёр на проде (apps.l10n.services.import_pack) отказывается
принимать пакет, чьё содержимое изменилось при той же pack_version
(PackVersionConflictError) — это защита от молчаливой подмены юрзначимых
текстов. 2026-08-20 деплой упал именно так: PR добавил ключ во все 29
пакетов, не подняв pack_version. Локально это не ловилось — тесты не знают,
что уже импортировано на проде.

Lock-файл делает это проверяемым без БД: тест
apps/l10n/tests/test_packs_lock.py требует, чтобы при изменении checksum
pack_version был строго больше записанного. Обновление — после bump:

    python l10n/lock_packs.py            # перезаписать lock
    python l10n/lock_packs.py --check    # только проверить (то же, что тест)

Checksum — тот же sha256, что у импортёра (всё содержимое без pack_version).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

PACKS_DIR = Path(__file__).resolve().parent / "packs"
LOCK_PATH = Path(__file__).resolve().parent / "packs.lock.json"


def checksum(data: dict) -> str:
    """Зеркало apps.l10n.services._checksum — менять только синхронно."""
    payload = {key: value for key, value in data.items() if key != "pack_version"}
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def current_state() -> dict[str, dict]:
    state: dict[str, dict] = {}
    for path in sorted(PACKS_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        state[path.stem] = {"pack_version": data["pack_version"], "checksum": checksum(data)}
    return state


def load_lock() -> dict[str, dict]:
    if not LOCK_PATH.exists():
        return {}
    return json.loads(LOCK_PATH.read_text(encoding="utf-8"))


def problems(current: dict[str, dict], locked: dict[str, dict]) -> list[str]:
    """Список нарушений (пусто = всё согласовано)."""
    out: list[str] = []
    for code, now in sorted(current.items()):
        was = locked.get(code)
        if was is None:
            out.append(f"{code}: пакета нет в lock — выполните python l10n/lock_packs.py")
            continue
        if now["checksum"] != was["checksum"] and now["pack_version"] <= was["pack_version"]:
            out.append(
                f"{code}: содержимое изменилось, а pack_version={now['pack_version']} "
                f"не выше записанного {was['pack_version']} — поднимите pack_version "
                f"и выполните python l10n/lock_packs.py"
            )
        elif now["checksum"] == was["checksum"] and now["pack_version"] != was["pack_version"]:
            out.append(
                f"{code}: pack_version изменился без изменения содержимого "
                f"({was['pack_version']} → {now['pack_version']}) — обновите lock "
                f"(python l10n/lock_packs.py) или верните версию"
            )
        elif now["checksum"] != was["checksum"]:
            out.append(
                f"{code}: pack_version поднят ({was['pack_version']} → "
                f"{now['pack_version']}), но lock не обновлён — python l10n/lock_packs.py"
            )
    for code in sorted(set(locked) - set(current)):
        out.append(f"{code}: в lock есть, пакета нет — python l10n/lock_packs.py")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="только проверить, не писать")
    args = parser.parse_args(argv)
    current = current_state()
    if args.check:
        found = problems(current, load_lock())
        for line in found:
            print(line, file=sys.stderr)
        return 1 if found else 0
    LOCK_PATH.write_text(
        json.dumps(current, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"{LOCK_PATH.name}: {len(current)} пакетов")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
