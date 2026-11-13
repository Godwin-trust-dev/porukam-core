"""Тесты `apply_pack_patch.py` (ADR-095, feat/l10n-user-language).

Модуль не пакетный (`l10n/` — не Python-пакет бэкенда), поэтому скрипт
грузится по пути через importlib, не обычным import — тот же приём, что в
`test_merge_checklists.py`/`test_merge_legal.py`."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_SCRIPT_PATH = Path(__file__).resolve().parent / "apply_pack_patch.py"
_spec = importlib.util.spec_from_file_location("apply_pack_patch", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
apply_pack_patch = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = apply_pack_patch
_spec.loader.exec_module(apply_pack_patch)


def _write_json(path: Path, data: dict[str, Any]) -> Path:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _pack(pack_version: int = 2) -> dict[str, Any]:
    return {
        "locale": "de",
        "name": "Deutsch",
        "rtl": False,
        "quality": "machine",
        "pack_version": pack_version,
        "errors": {"otp_invalid_code": "Ungültiger Code"},
        "notifications": {
            "contract.signed": {"subject": "Unterzeichnet", "body": "«{contract_title}»."}
        },
        "ui": {"common.sign": "Unterschreiben"},
    }


@pytest.fixture()
def packs_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "packs"
    directory.mkdir()
    return directory


# --- «только недостающее» -------------------------------------------------


def test_existing_value_is_never_overwritten(packs_dir: Path):
    """Главное свойство скрипта: перевод, который уже лежит в пакете, старше и
    ближе к ревью носителем, чем то, что доливает патч."""
    path = _write_json(packs_dir / "de.json", _pack())

    added, _ = apply_pack_patch.apply_one(
        "de", {"errors": {"otp_invalid_code": "МАШИННЫЙ ПЕРЕВОД"}}, packs_dir
    )

    assert added == []
    assert json.loads(path.read_text(encoding="utf-8"))["errors"] == {
        "otp_invalid_code": "Ungültiger Code"
    }


def test_missing_key_is_added_inside_existing_namespace(packs_dir: Path):
    path = _write_json(packs_dir / "de.json", _pack())

    added, _ = apply_pack_patch.apply_one(
        "de", {"errors": {"contract_frozen": "Vertrag eingefroren"}}, packs_dir
    )

    assert added == ["errors.contract_frozen"]
    errors = json.loads(path.read_text(encoding="utf-8"))["errors"]
    # добавленное И существующее — рядом, namespace не подменён целиком
    assert errors == {
        "otp_invalid_code": "Ungültiger Code",
        "contract_frozen": "Vertrag eingefroren",
    }


def test_empty_string_counts_as_missing(packs_dir: Path):
    """Пустая строка в пакете — дырка, а не «переведено пустым»: именно так
    выглядят ключи, заведённые шапкой волны и не наполненные контентом."""
    pack = _pack()
    pack["errors"]["contract_frozen"] = ""
    path = _write_json(packs_dir / "de.json", pack)

    added, _ = apply_pack_patch.apply_one(
        "de", {"errors": {"contract_frozen": "Vertrag eingefroren"}}, packs_dir
    )

    assert added == ["errors.contract_frozen"]
    assert json.loads(path.read_text(encoding="utf-8"))["errors"]["contract_frozen"] == (
        "Vertrag eingefroren"
    )


def test_absent_namespace_is_created(packs_dir: Path):
    path = _write_json(packs_dir / "de.json", _pack())

    body = {"subject": "Streit", "body": "«{contract_title}»."}
    added, _ = apply_pack_patch.apply_one(
        "de", {"notifications": {"dispute.opened": body}}, packs_dir
    )

    assert added == ["notifications.dispute.opened.subject", "notifications.dispute.opened.body"]
    notifications = json.loads(path.read_text(encoding="utf-8"))["notifications"]
    assert notifications["contract.signed"]["subject"] == "Unterzeichnet"
    assert notifications["dispute.opened"]["body"] == "«{contract_title}»."


def test_scalar_where_patch_expects_object_is_refused_not_overwritten(packs_dir: Path):
    """Расхождение схемы — повод остановиться, а не молча затереть: под
    `notifications.<код>` в пакете обязан быть объект subject/body."""
    pack = _pack()
    pack["notifications"]["dispute.opened"] = "строка вместо объекта"
    _write_json(packs_dir / "de.json", pack)

    with pytest.raises(SystemExit):
        apply_pack_patch.apply_one(
            "de", {"notifications": {"dispute.opened": {"subject": "Streit"}}}, packs_dir
        )


# --- pack_version ---------------------------------------------------------


def test_bumps_pack_version_when_keys_added(packs_dir: Path):
    """Без бампа деплой не «не обновит пакет», а УПАДЁТ: `import_l10n_pack`
    считает checksum по пакету без `pack_version` (apps.l10n.services._checksum)
    и на «та же версия, другое содержимое» кидает PackVersionConflictError, а
    `.github/workflows/deploy-staging.yml` гоняет импорт с `|| exit 1`."""
    path = _write_json(packs_dir / "de.json", _pack(pack_version=2))

    added, new_version = apply_pack_patch.apply_one(
        "de", {"errors": {"contract_frozen": "Vertrag eingefroren"}}, packs_dir
    )

    assert added
    assert new_version == 3
    assert json.loads(path.read_text(encoding="utf-8"))["pack_version"] == 3


def test_does_not_bump_when_nothing_added(packs_dir: Path):
    """Идемпотентность как у `merge_checklists.py`/`merge_legal.py`: повторный
    прогон того же патча не должен гнать версию вверх на пустом месте —
    иначе каждый прогон требовал бы нового импорта ради нулевого diff'а."""
    path = _write_json(packs_dir / "de.json", _pack(pack_version=2))

    added, new_version = apply_pack_patch.apply_one(
        "de", {"errors": {"otp_invalid_code": "МАШИННЫЙ ПЕРЕВОД"}}, packs_dir
    )

    assert (added, new_version) == ([], None)
    assert json.loads(path.read_text(encoding="utf-8"))["pack_version"] == 2


def test_second_run_of_same_patch_is_a_no_op(packs_dir: Path):
    path = _write_json(packs_dir / "de.json", _pack(pack_version=2))
    patch = {"errors": {"contract_frozen": "Vertrag eingefroren"}}

    apply_pack_patch.apply_one("de", patch, packs_dir)
    first = path.read_text(encoding="utf-8")
    apply_pack_patch.apply_one("de", patch, packs_dir)

    assert path.read_text(encoding="utf-8") == first


# --- вход -----------------------------------------------------------------


def test_missing_pack_file_stops_instead_of_creating_one(packs_dir: Path):
    """Незнакомый код языка — опечатка в патче, а не заявка на новый язык:
    языки заводятся волной целиком (README, `import_l10n_pack`)."""
    with pytest.raises(SystemExit):
        apply_pack_patch.apply_one("xx", {"errors": {"a": "b"}}, packs_dir)


def test_load_patch_merges_files_first_wins(tmp_path: Path):
    a = _write_json(tmp_path / "a.json", {"de": {"errors": {"one": "первый файл"}}})
    b = _write_json(tmp_path / "b.json", {"de": {"errors": {"one": "второй файл", "two": "b"}}})

    patch = apply_pack_patch.load_patch([a, b])

    assert patch == {"de": {"errors": {"one": "первый файл", "two": "b"}}}
