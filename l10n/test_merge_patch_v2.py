"""Тесты `merge_patch_v2.py` (chore/l10n-patch-v2-langs — слияние errors +
catalog.contract_types патча v2 в l10n/packs/<code>.json, на уровне файлов,
тот же приём что merge_checklists.py, см. докстринг скрипта).

Модуль не пакетный (`l10n/` — не Python-пакет бэкенда), поэтому скрипт
грузится по пути через importlib, не обычным import."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPT_PATH = Path(__file__).resolve().parent / "merge_patch_v2.py"
_spec = importlib.util.spec_from_file_location("merge_patch_v2", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
merge_patch_v2 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = merge_patch_v2
_spec.loader.exec_module(merge_patch_v2)


# --- фикстуры-хелперы --------------------------------------------------------

_REFERENCE_ERRORS = {
    "otp_invalid_code": "Incorrect code",
    "permission_denied": "Permission denied",
}
_REFERENCE_CONTRACT_TYPES = {
    "services_individual": "Services (individual)",
    "sale_personal": "Sale of personal items",
}


def _write_json(path: Path, data: dict) -> Path:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _en_reference_pack() -> dict:
    return {
        "locale": "en",
        "name": "English",
        "rtl": False,
        "quality": "canonical",
        "pack_version": 3,
        "errors": dict(_REFERENCE_ERRORS),
        "catalog": {"contract_types": dict(_REFERENCE_CONTRACT_TYPES)},
    }


def _valid_patch(locale: str = "es", *, rtl: bool = False) -> dict:
    return {
        "locale": locale,
        "name": "Español",
        "rtl": rtl,
        "quality": "machine",
        "pack_version": 2,
        "_note": "Patch v2 (2026-08-13). ...",
        "errors": {
            "otp_invalid_code": "Código incorrecto",
            "permission_denied": "Permiso denegado",
        },
        "catalog": {
            "contract_types": {
                "services_individual": "Servicios (individual)",
                "sale_personal": "Venta de artículos personales",
            }
        },
    }


def _target_pack(*, rtl: bool = False, pack_version: int = 1) -> dict:
    return {
        "locale": "es",
        "name": "Español",
        "rtl": rtl,
        "quality": "machine",
        "pack_version": pack_version,
        "errors": {"otp_invalid_code": "Código viejo"},
        "notifications": {"contract.signed": {"subject": "Firmado"}},
        "catalog": {
            "spheres": {"design": "Diseño"},
            "contract_types": {"services_individual": "Servicios viejo"},
            "client_tree": {"root": "raíz"},
        },
        "ui": {"common.sign": "Firmar"},
        "legal": {"tos": None},
    }


@pytest.fixture()
def env(tmp_path: Path):
    patch_dir = tmp_path / "patch"
    packs_dir = tmp_path / "packs"
    patch_dir.mkdir()
    packs_dir.mkdir()
    _write_json(packs_dir / "en.json", _en_reference_pack())
    reference_errors, reference_contract_types = merge_patch_v2.load_reference(packs_dir)
    return patch_dir, packs_dir, reference_errors, reference_contract_types


# --- маска --------------------------------------------------------------------


def test_discover_matches_only_patch_v2_suffix_not_original_as_supplied(env):
    patch_dir, packs_dir, *_ = env
    _write_json(patch_dir / "es.patch-v2.json", _valid_patch())
    _write_json(patch_dir / "en.patch-v2.ORIGINAL-as-supplied.json", _valid_patch(locale="en"))

    found = {p.name for p in merge_patch_v2.discover_patch_files(patch_dir)}

    assert found == {"es.patch-v2.json"}
    assert "en.patch-v2.ORIGINAL-as-supplied.json" not in found


# --- happy path -----------------------------------------------------------------


def test_merge_replaces_errors_and_contract_types_bumps_version_keeps_other_namespaces(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch_path = _write_json(patch_dir / "es.patch-v2.json", _valid_patch())
    pack_path = _write_json(packs_dir / "es.json", _target_pack(pack_version=1))

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "merged"
    assert result.new_version == 2

    merged = json.loads(pack_path.read_text(encoding="utf-8"))
    assert merged["pack_version"] == 2
    assert merged["errors"] == _valid_patch()["errors"]
    assert merged["catalog"]["contract_types"] == _valid_patch()["catalog"]["contract_types"]
    # _note патча в пакет не переносится
    assert "_note" not in merged
    # остальные namespace и остальные подключи catalog нетронуты
    assert merged["notifications"] == {"contract.signed": {"subject": "Firmado"}}
    assert merged["catalog"]["spheres"] == {"design": "Diseño"}
    assert merged["catalog"]["client_tree"] == {"root": "raíz"}
    assert merged["ui"] == {"common.sign": "Firmar"}
    assert merged["legal"] == {"tos": None}
    # шапка пакета (locale/name/rtl/quality) — истина пакета, не патч-файла
    assert merged["locale"] == "es"
    assert merged["quality"] == "machine"


# --- идемпотентность -------------------------------------------------------------


def test_second_run_is_a_no_op(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch_path = _write_json(patch_dir / "es.patch-v2.json", _valid_patch())
    _write_json(packs_dir / "es.json", _target_pack(pack_version=1))

    first = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)
    assert first.status == "merged"
    assert first.new_version == 2

    second = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)
    assert second.status == "skip"

    pack_path = packs_dir / "es.json"
    assert json.loads(pack_path.read_text(encoding="utf-8"))["pack_version"] == 2


# --- локали вне прогона: en/ru ----------------------------------------------------


@pytest.mark.parametrize("locale", ["en", "ru"])
def test_en_and_ru_are_skipped_without_reading_the_file(env, locale):
    patch_dir, packs_dir, ref_errors, ref_types = env
    # файла пакета для этой locale нет вообще — если бы скрипт полез читать
    # патч/пакет, а не пропустил по имени, он бы упал с другой ошибкой
    patch_path = _write_json(patch_dir / f"{locale}.patch-v2.json", _valid_patch(locale=locale))

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "skip"
    assert "отдельной веткой" in result.detail


# --- отказы: ключи -----------------------------------------------------------------


def test_extra_error_key_relative_to_reference_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch = _valid_patch()
    patch["errors"]["extra_code"] = "Texto extra"
    patch_path = _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "лишние" in result.detail


def test_missing_error_key_relative_to_reference_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch = _valid_patch()
    del patch["errors"]["permission_denied"]
    patch_path = _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "не хватает" in result.detail


def test_error_keys_out_of_en_order_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch = _valid_patch()
    # тот же набор ключей, обратный порядок
    patch["errors"] = dict(reversed(list(patch["errors"].items())))
    patch_path = _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "порядок не EN" in result.detail


def test_missing_contract_type_key_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch = _valid_patch()
    del patch["catalog"]["contract_types"]["sale_personal"]
    patch_path = _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "contract_types" in result.detail
    assert "не хватает" in result.detail


# --- отказы: содержимое значений -----------------------------------------------------


def test_empty_error_value_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch = _valid_patch()
    patch["errors"]["otp_invalid_code"] = "   "
    patch_path = _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "пустое значение" in result.detail


def test_empty_contract_type_value_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch = _valid_patch()
    patch["catalog"]["contract_types"]["sale_personal"] = ""
    patch_path = _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "пустое значение" in result.detail


# --- отказы: шапка -----------------------------------------------------------------


def test_locale_header_mismatch_with_filename_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch = _valid_patch(locale="fr")  # имя файла — es.patch-v2.json
    patch_path = _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "не совпадает с кодом в имени файла" in result.detail


def test_rtl_mismatch_with_target_pack_is_rejected(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch_path = _write_json(patch_dir / "es.patch-v2.json", _valid_patch(rtl=True))
    _write_json(packs_dir / "es.json", _target_pack(rtl=False))

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "error"
    assert "rtl" in result.detail


# --- красная линия: нет базового пакета → skip, не error ----------------------------


def test_missing_target_pack_is_skipped_not_errored(env):
    patch_dir, packs_dir, ref_errors, ref_types = env
    patch_path = _write_json(patch_dir / "ar.patch-v2.json", _valid_patch(locale="ar"))
    # l10n/packs/ar.json намеренно не создаём

    result = merge_patch_v2.merge_one(patch_path, packs_dir, ref_errors, ref_types)

    assert result.status == "skip"
    assert "базового пакета нет" in result.detail


# --- main(): сквозной прогон по каталогу -------------------------------------------


def test_main_over_directory_reports_summary_and_excludes_original_as_supplied(env, capsys):
    patch_dir, packs_dir, *_ = env
    _write_json(patch_dir / "es.patch-v2.json", _valid_patch())
    _write_json(patch_dir / "en.patch-v2.json", _valid_patch(locale="en"))
    _write_json(patch_dir / "en.patch-v2.ORIGINAL-as-supplied.json", _valid_patch(locale="en"))
    _write_json(packs_dir / "es.json", _target_pack())

    exit_code = merge_patch_v2.main(["--patch-dir", str(patch_dir), "--packs-dir", str(packs_dir)])

    assert exit_code == 0
    out = capsys.readouterr().out
    assert "es:" in out
    assert "en:" in out
    assert "ORIGINAL-as-supplied" not in out
    assert "1 слито, 1 без изменений/skip, 0 ошибок из 2" in out


def test_main_reports_nonzero_exit_when_any_file_errors(env):
    patch_dir, packs_dir, *_ = env
    patch = _valid_patch()
    del patch["errors"]["permission_denied"]
    _write_json(patch_dir / "es.patch-v2.json", patch)
    _write_json(packs_dir / "es.json", _target_pack())

    exit_code = merge_patch_v2.main(["--patch-dir", str(patch_dir), "--packs-dir", str(packs_dir)])

    assert exit_code == 1
