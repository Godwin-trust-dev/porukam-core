"""Стражник «содержимое пакета изменилось → pack_version поднят».

Импортёр на проде отказывает пакету с тем же pack_version и другим
содержимым (PackVersionConflictError) — 2026-08-20 на этом упал деплой:
ключ добавили во все 29 пакетов, версию не подняли. Локальные тесты этого
не видели — они не знают, что уже импортировано. `l10n/packs.lock.json`
(l10n/lock_packs.py) — слепок последнего согласованного состояния; тест
сверяет с ним текущие файлы без БД.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

from apps.l10n import services

_REPO_ROOT = Path(__file__).resolve().parents[4]
_LOCK_SCRIPT = _REPO_ROOT / "l10n" / "lock_packs.py"


def _load_lock_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("lock_packs", _LOCK_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_lock = _load_lock_module()


def test_pack_versions_bumped_for_changed_content() -> None:
    found = _lock.problems(_lock.current_state(), _lock.load_lock())
    assert not found, "\n".join(found)


@pytest.mark.parametrize("path", sorted(_lock.PACKS_DIR.glob("*.json")), ids=lambda p: p.stem)
def test_lock_checksum_mirrors_importer_checksum(path: Path) -> None:
    """l10n/lock_packs.checksum — зеркало services._checksum; разъедутся —
    стражник начнёт врать в обе стороны."""
    data = json.loads(path.read_text(encoding="utf-8"))
    assert _lock.checksum(data) == services._checksum(data)
