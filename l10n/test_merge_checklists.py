"""Тесты `merge_checklists.py` (chore/l10n-checklists-merge, вариант B —
слияние на уровне файлов, `import_pack`/`LocalePack`/деплой-цикл не
трогаем, см. docstring скрипта и docs/tasks/Задача_chore_l10n-checklists-merge.md).

Модуль не пакетный (`l10n/` — не Python-пакет бэкенда), поэтому скрипт
грузится по пути через importlib, не обычным import."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPT_PATH = Path(__file__).resolve().parent / "merge_checklists.py"
_spec = importlib.util.spec_from_file_location("merge_checklists", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
merge_checklists = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = merge_checklists
_spec.loader.exec_module(merge_checklists)


# --- фикстуры-хелперы ---------------------------------------------------

_SOURCE = {
    "catalog.checklists.appliance.climate.ac_install.1": "Текст 1 RU",
    "catalog.checklists.appliance.climate.ac_install.2": "Текст 2 RU",
}


def _write_json(path: Path, data: dict) -> Path:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _valid_checklists_pack(locale: str = "es", *, rtl: bool = False) -> dict:
    return {
        "locale": locale,
        "name": "Español",
        "rtl": rtl,
        "quality": "machine",
        "pack_version": 1,
        "catalog": {
            "checklists": {
                "catalog.checklists.appliance.climate.ac_install.1": "Texto 1 ES",
                "catalog.checklists.appliance.climate.ac_install.2": "Texto 2 ES",
            }
        },
    }


def _target_pack(*, rtl: bool = False, pack_version: int = 2) -> dict:
    return {
        "locale": "es",
        "name": "Español",
        "rtl": rtl,
        "quality": "machine",
        "pack_version": pack_version,
        "errors": {"otp_invalid_code": "Código inválido"},
        "notifications": {"contract.signed": {"subject": "Firmado"}},
        "catalog": {"spheres": {"design": "Diseño"}},
        "ui": {"common.sign": "Firmar"},
        "legal": {"tos": None},
    }


@pytest.fixture()
def env(tmp_path: Path):
    checklists_dir = tmp_path / "checklists"
    packs_dir = tmp_path / "packs"
    checklists_dir.mkdir()
    packs_dir.mkdir()
    source_path = _write_json(checklists_dir / "_source.ru.json", _SOURCE)
    return checklists_dir, packs_dir, source_path


# --- маска ----------------------------------------------------------------


def test_discover_matches_only_checklists_suffix_not_source(env):
    checklists_dir, packs_dir, source_path = env
    _write_json(checklists_dir / "es.checklists.json", _valid_checklists_pack())

    found = {p.name for p in merge_checklists.discover_checklists_files(checklists_dir)}

    assert found == {"es.checklists.json"}
    assert "_source.ru.json" not in found


# --- happy path -------------------------------------------------------------


def test_merge_adds_catalog_checklists_bumps_version_keeps_other_namespaces(env):
    checklists_dir, packs_dir, source_path = env
    checklists_path = _write_json(checklists_dir / "es.checklists.json", _valid_checklists_pack())
    pack_path = _write_json(packs_dir / "es.json", _target_pack(pack_version=2))
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "merged"
    assert result.new_version == 3

    merged = json.loads(pack_path.read_text(encoding="utf-8"))
    assert merged["pack_version"] == 3
    assert merged["catalog"]["checklists"] == _valid_checklists_pack()["catalog"]["checklists"]
    # остальные namespace и остальные подключи catalog нетронуты
    assert merged["errors"] == {"otp_invalid_code": "Código inválido"}
    assert merged["notifications"] == {"contract.signed": {"subject": "Firmado"}}
    assert merged["catalog"]["spheres"] == {"design": "Diseño"}
    assert merged["ui"] == {"common.sign": "Firmar"}
    assert merged["legal"] == {"tos": None}
    # шапка пакета (locale/name/rtl/quality) — истина пакета, не checklists-файла
    assert merged["locale"] == "es"
    assert merged["quality"] == "machine"


# --- идемпотентность --------------------------------------------------------


def test_second_run_is_a_no_op(env):
    checklists_dir, packs_dir, source_path = env
    checklists_path = _write_json(checklists_dir / "es.checklists.json", _valid_checklists_pack())
    _write_json(packs_dir / "es.json", _target_pack(pack_version=2))
    source_keys = merge_checklists.load_source_keys(source_path)

    first = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)
    assert first.status == "merged"
    assert first.new_version == 3

    second = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)
    assert second.status == "skip"

    pack_path = packs_dir / "es.json"
    assert json.loads(pack_path.read_text(encoding="utf-8"))["pack_version"] == 3


# --- отказы: ключи -----------------------------------------------------------


def test_extra_key_relative_to_source_is_rejected(env):
    checklists_dir, packs_dir, source_path = env
    pack = _valid_checklists_pack()
    pack["catalog"]["checklists"]["catalog.checklists.extra.not_in_source.1"] = "Extra"
    checklists_path = _write_json(checklists_dir / "es.checklists.json", pack)
    _write_json(packs_dir / "es.json", _target_pack())
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "error"
    assert "лишние" in result.detail


def test_missing_key_relative_to_source_is_rejected(env):
    checklists_dir, packs_dir, source_path = env
    pack = _valid_checklists_pack()
    del pack["catalog"]["checklists"]["catalog.checklists.appliance.climate.ac_install.2"]
    checklists_path = _write_json(checklists_dir / "es.checklists.json", pack)
    _write_json(packs_dir / "es.json", _target_pack())
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "error"
    assert "не хватает" in result.detail


# --- отказы: содержимое значений --------------------------------------------


@pytest.mark.parametrize("marker", ["[Л]", "[L]"])
def test_uncleaned_marker_is_rejected(env, marker):
    checklists_dir, packs_dir, source_path = env
    pack = _valid_checklists_pack()
    pack["catalog"]["checklists"]["catalog.checklists.appliance.climate.ac_install.1"] = (
        f"{marker} Texto sensible"
    )
    checklists_path = _write_json(checklists_dir / "es.checklists.json", pack)
    _write_json(packs_dir / "es.json", _target_pack())
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "error"
    assert marker in result.detail


def test_empty_value_is_rejected(env):
    checklists_dir, packs_dir, source_path = env
    pack = _valid_checklists_pack()
    pack["catalog"]["checklists"]["catalog.checklists.appliance.climate.ac_install.1"] = "   "
    checklists_path = _write_json(checklists_dir / "es.checklists.json", pack)
    _write_json(packs_dir / "es.json", _target_pack())
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "error"
    assert "пустое значение" in result.detail


# --- отказы: шапка -----------------------------------------------------------


def test_locale_header_mismatch_with_filename_is_rejected(env):
    checklists_dir, packs_dir, source_path = env
    pack = _valid_checklists_pack(locale="fr")  # имя файла — es.checklists.json
    checklists_path = _write_json(checklists_dir / "es.checklists.json", pack)
    _write_json(packs_dir / "es.json", _target_pack())
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "error"
    assert "не совпадает с кодом в имени файла" in result.detail


def test_rtl_mismatch_with_target_pack_is_rejected(env):
    checklists_dir, packs_dir, source_path = env
    checklists_path = _write_json(
        checklists_dir / "es.checklists.json", _valid_checklists_pack(rtl=True)
    )
    _write_json(packs_dir / "es.json", _target_pack(rtl=False))
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "error"
    assert "rtl" in result.detail


def test_missing_target_pack_is_rejected(env):
    checklists_dir, packs_dir, source_path = env
    checklists_path = _write_json(checklists_dir / "es.checklists.json", _valid_checklists_pack())
    source_keys = merge_checklists.load_source_keys(source_path)

    result = merge_checklists.merge_one(checklists_path, packs_dir, source_keys)

    assert result.status == "error"
    assert "не найден" in result.detail


# --- main(): сквозной прогон по каталогу -------------------------------------


def test_main_over_directory_skips_source_and_reports_summary(env, capsys):
    checklists_dir, packs_dir, source_path = env
    _write_json(checklists_dir / "es.checklists.json", _valid_checklists_pack())
    _write_json(packs_dir / "es.json", _target_pack())

    exit_code = merge_checklists.main(
        ["--checklists-dir", str(checklists_dir), "--packs-dir", str(packs_dir)]
    )

    assert exit_code == 0
    out = capsys.readouterr().out
    assert "es:" in out
    assert "_source" not in out
    assert "1 слито, 0 без изменений, 0 ошибок из 1" in out


def test_main_reports_nonzero_exit_when_any_file_errors(env):
    checklists_dir, packs_dir, source_path = env
    pack = _valid_checklists_pack()
    del pack["catalog"]["checklists"]["catalog.checklists.appliance.climate.ac_install.2"]
    _write_json(checklists_dir / "es.checklists.json", pack)
    _write_json(packs_dir / "es.json", _target_pack())

    exit_code = merge_checklists.main(
        ["--checklists-dir", str(checklists_dir), "--packs-dir", str(packs_dir)]
    )

    assert exit_code == 1
