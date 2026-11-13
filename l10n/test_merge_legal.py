"""Тесты `merge_legal.py` (feat/l10n-launch-surfaces) — слияние юр-документов
`docs/legal/<code>/` в `l10n/packs/<code>.json` на уровне файлов, тем же
приёмом, что `merge_checklists.py` (ADR-083).

Модуль не пакетный (`l10n/` — не Python-пакет бэкенда), поэтому скрипт
грузится по пути через importlib, не обычным import."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPT_PATH = Path(__file__).resolve().parent / "merge_legal.py"
_spec = importlib.util.spec_from_file_location("merge_legal", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
merge_legal = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = merge_legal
_spec.loader.exec_module(merge_legal)


# --- фикстуры-хелперы ---------------------------------------------------

_EN_PRIVACY = """# Privacy Policy

**Version:** 1.0 · Effective 17 August 2026

---

## 1. What we store

| Data | Why |
|---|---|
| Name | Account |

## 2. What we never store

Nothing else. Write to hello@trust-dev.com or see the
[permissions page](https://myaccount.google.com/permissions).
"""

_EN_TERMS = """# Terms of Service

**Version:** 1.0 · Effective 17 August 2026

---

## 1. Who runs this Service

One person.
"""

_EN_NOTICE = "This English text is the authoritative version of this document.\n"

# Перевод: те же 2 раздела и 3 строки таблицы у privacy, 1 раздел у terms.
_ES_PRIVACY = """# Política de privacidad

**Versión:** 1.0 · En vigor desde el 17 de agosto de 2026

---

## 1. Qué almacenamos

| Datos | Para qué |
|---|---|
| Nombre | Cuenta |

## 2. Qué no almacenamos nunca

Nada más. Escribe a hello@trust-dev.com o consulta la
[página de permisos](https://myaccount.google.com/permissions).
"""

_ES_TERMS = """# Condiciones del servicio

**Versión:** 1.0 · En vigor desde el 17 de agosto de 2026

---

## 1. Quién presta el servicio

Una persona.
"""

_ES_NOTICE = "Esta traducción se ofrece solo por comodidad; prevalece la versión inglesa.\n"


def _write_locale(legal_dir: Path, locale: str, privacy: str, terms: str, notice: str) -> Path:
    d = legal_dir / locale
    d.mkdir(parents=True, exist_ok=True)
    (d / "privacy.md").write_text(privacy, encoding="utf-8")
    (d / "terms.md").write_text(terms, encoding="utf-8")
    (d / "notice.md").write_text(notice, encoding="utf-8")
    return d


def _pack(locale: str = "es", *, pack_version: int = 3) -> dict:
    """Целевой пакет с уже заполненными ДРУГИМИ namespace — проверяем, что
    слияние их не затирает (главный риск варианта «второй import_l10n_pack»)."""
    return {
        "locale": locale,
        "name": "Español",
        "rtl": False,
        "quality": "machine",
        "pack_version": pack_version,
        "errors": {"otp_invalid_code": "El código es incorrecto."},
        "ui": {"common.retry": "Reintentar"},
        "legal": {
            "translation_disclaimer": "Está viendo una traducción por conveniencia.",
            "tos": None,
            "privacy": None,
            "consents": {"pd_processing": None},
        },
    }


@pytest.fixture
def env(tmp_path: Path):
    """`docs/legal/` с эталоном `en` + перевод `es`, и `l10n/packs/es.json`."""
    legal_dir = tmp_path / "docs" / "legal"
    packs_dir = tmp_path / "l10n" / "packs"
    packs_dir.mkdir(parents=True)
    _write_locale(legal_dir, "en", _EN_PRIVACY, _EN_TERMS, _EN_NOTICE)
    _write_locale(legal_dir, "es", _ES_PRIVACY, _ES_TERMS, _ES_NOTICE)
    (packs_dir / "es.json").write_text(
        json.dumps(_pack(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (packs_dir / "en.json").write_text(
        json.dumps(_pack("en"), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return legal_dir, packs_dir


def _read_pack(packs_dir: Path, locale: str = "es") -> dict:
    with (packs_dir / f"{locale}.json").open(encoding="utf-8") as f:
        return json.load(f)


def _merge(env, *locales: str, check: bool = False):
    legal_dir, packs_dir = env
    argv = [*locales, "--legal-dir", str(legal_dir), "--packs-dir", str(packs_dir)]
    if check:
        argv.append("--check")
    return merge_legal.main(argv)


# --- слияние ------------------------------------------------------------


def test_merge_fills_legal_slots_bumps_version_keeps_other_namespaces(env):
    _, packs_dir = env
    assert _merge(env, "es") == 0

    pack = _read_pack(packs_dir)
    assert pack["legal"]["privacy"].startswith("# Política de privacidad")
    assert pack["legal"]["tos"].startswith("# Condiciones del servicio")
    assert pack["legal"]["document_notice"] == _ES_NOTICE.strip() + "\n"
    assert pack["pack_version"] == 4
    # Остальные namespace и остальные ключи legal — на месте.
    assert pack["errors"] == {"otp_invalid_code": "El código es incorrecto."}
    assert pack["ui"] == {"common.retry": "Reintentar"}
    assert pack["legal"]["translation_disclaimer"] == "Está viendo una traducción por conveniencia."
    assert pack["legal"]["consents"] == {"pd_processing": None}


def test_second_run_is_a_no_op(env):
    _, packs_dir = env
    assert _merge(env, "es") == 0
    version_after_first = _read_pack(packs_dir)["pack_version"]

    assert _merge(env, "es") == 0
    assert _read_pack(packs_dir)["pack_version"] == version_after_first


def test_check_mode_validates_without_writing(env):
    _, packs_dir = env
    assert _merge(env, "es", check=True) == 0
    pack = _read_pack(packs_dir)
    assert pack["pack_version"] == 3
    assert pack["legal"]["privacy"] is None


def test_discover_covers_every_locale_directory(env):
    legal_dir, packs_dir = env
    assert merge_legal.discover_locales(legal_dir) == ["en", "es"]
    assert _merge(env) == 0
    assert _read_pack(packs_dir, "en")["legal"]["privacy"].startswith("# Privacy Policy")
    assert _read_pack(packs_dir, "es")["legal"]["privacy"].startswith("# Política")


# --- валидация (отказ до записи) ----------------------------------------


def test_missing_section_relative_to_reference_is_rejected(env, capsys):
    legal_dir, packs_dir = env
    truncated = _ES_PRIVACY.split("## 2.")[0]
    (legal_dir / "es" / "privacy.md").write_text(truncated, encoding="utf-8")

    assert _merge(env, "es") == 1
    assert "обрезанный перевод" in capsys.readouterr().out
    assert _read_pack(packs_dir)["pack_version"] == 3


def test_lost_table_is_rejected(env, capsys):
    legal_dir, packs_dir = env
    no_table = "\n".join(
        line for line in _ES_PRIVACY.splitlines() if not line.startswith("|")
    )
    (legal_dir / "es" / "privacy.md").write_text(no_table + "\n", encoding="utf-8")

    assert _merge(env, "es") == 1
    assert "потерянная таблица" in capsys.readouterr().out
    assert _read_pack(packs_dir)["legal"]["privacy"] is None


def test_version_mismatch_with_reference_is_rejected(env, capsys):
    legal_dir, _ = env
    stale = _ES_PRIVACY.replace("1.0", "0.9")
    (legal_dir / "es" / "privacy.md").write_text(stale, encoding="utf-8")

    assert _merge(env, "es") == 1
    assert "версия в шапке" in capsys.readouterr().out


@pytest.mark.parametrize("marker", ["TODO", "TBD", "FIXME", "[Л]"])
def test_placeholder_marker_is_rejected(env, capsys, marker):
    legal_dir, _ = env
    (legal_dir / "es" / "terms.md").write_text(
        _ES_TERMS.replace("Una persona.", f"{marker} перевести"), encoding="utf-8"
    )

    assert _merge(env, "es") == 1
    assert "заглушка" in capsys.readouterr().out


@pytest.mark.parametrize("word", ["todo", "todos los datos", "Todo el perfil"])
def test_lowercase_todo_is_an_ordinary_word_not_a_placeholder(env, word):
    """«todo/todos» — обычное слово романских языков; регистронезависимый поиск
    подстроки заваливал бы на нём каждый испанский/итальянский/португальский
    перевод (так и случилось на первом прогоне волны)."""
    legal_dir, _ = env
    (legal_dir / "es" / "terms.md").write_text(
        _ES_TERMS.replace("Una persona.", f"Se aplica a {word}."), encoding="utf-8"
    )

    assert _merge(env, "es") == 0


def test_swapped_link_target_is_rejected(env, capsys):
    """Подменённый адрес ссылки — не косметика: текст рядом обещает одно, а
    ссылка ведёт в другое место (реальный случай на волне переводов)."""
    legal_dir, _ = env
    (legal_dir / "es" / "privacy.md").write_text(
        _ES_PRIVACY.replace(
            "https://myaccount.google.com/permissions",
            "https://developers.google.com/terms/api-services-user-data-policy",
        ),
        encoding="utf-8",
    )

    assert _merge(env, "es") == 1
    assert "адреса ссылок расходятся" in capsys.readouterr().out


def test_sentence_final_dot_is_not_part_of_the_email(env):
    """«…@gmail.com.» в конце предложения и «…@gmail.com» без точки — один и тот
    же адрес. Язык, который не ставит точку в конце фразы (тайский), не должен
    из-за этого «терять» контакт."""
    legal_dir, _ = env
    (legal_dir / "es" / "privacy.md").write_text(
        _ES_PRIVACY.replace("hello@trust-dev.com o", "hello@trust-dev.com"),
        encoding="utf-8",
    )

    assert _merge(env, "es") == 0


def test_agglutinated_suffix_after_email_is_not_a_different_address(env):
    """Грузинский/армянский/казахский приклеивают послелог к адресу
    («…@gmail.com-ზე») — это норма языка. Адрес при этом тот же."""
    legal_dir, _ = env
    (legal_dir / "es" / "privacy.md").write_text(
        _ES_PRIVACY.replace("hello@trust-dev.com o", "hello@trust-dev.com-ზე o"),
        encoding="utf-8",
    )

    assert _merge(env, "es") == 0


def test_mangled_contact_email_is_rejected(env, capsys):
    legal_dir, _ = env
    (legal_dir / "es" / "privacy.md").write_text(
        _ES_PRIVACY.replace("hello@trust-dev.com", "contacto@porukam.app"),
        encoding="utf-8",
    )

    assert _merge(env, "es") == 1
    assert "адреса e-mail расходятся" in capsys.readouterr().out


def test_missing_file_is_rejected(env, capsys):
    legal_dir, _ = env
    (legal_dir / "es" / "notice.md").unlink()

    assert _merge(env, "es") == 1
    assert "файл не найден" in capsys.readouterr().out


def test_empty_document_is_rejected(env, capsys):
    legal_dir, _ = env
    (legal_dir / "es" / "terms.md").write_text("\n  \n", encoding="utf-8")

    assert _merge(env, "es") == 1
    assert "пустой файл" in capsys.readouterr().out


def test_notice_with_heading_is_rejected(env, capsys):
    legal_dir, _ = env
    (legal_dir / "es" / "notice.md").write_text("## Aviso\n\nTexto.\n", encoding="utf-8")

    assert _merge(env, "es") == 1
    assert "один абзац" in capsys.readouterr().out


def test_two_h1_headings_are_rejected(env, capsys):
    legal_dir, _ = env
    (legal_dir / "es" / "terms.md").write_text(_ES_TERMS + "\n# Otro\n", encoding="utf-8")

    assert _merge(env, "es") == 1
    assert "ровно один заголовок" in capsys.readouterr().out


def test_missing_target_pack_is_rejected(env, capsys):
    legal_dir, packs_dir = env
    _write_locale(legal_dir, "de", _ES_PRIVACY, _ES_TERMS, _ES_NOTICE)

    assert _merge(env, "de") == 1
    assert "целевой пакет не найден" in capsys.readouterr().out


def test_missing_reference_locale_is_a_hard_stop(tmp_path, capsys):
    legal_dir = tmp_path / "docs" / "legal"
    packs_dir = tmp_path / "l10n" / "packs"
    packs_dir.mkdir(parents=True)
    _write_locale(legal_dir, "es", _ES_PRIVACY, _ES_TERMS, _ES_NOTICE)

    code = merge_legal.main(["--legal-dir", str(legal_dir), "--packs-dir", str(packs_dir)])
    assert code == 2
    assert "эталон" in capsys.readouterr().err


def test_one_broken_locale_does_not_block_the_others(env, capsys):
    legal_dir, packs_dir = env
    _write_locale(legal_dir, "de", "# Kaputt\n", _ES_TERMS, _ES_NOTICE)
    (packs_dir / "de.json").write_text(
        json.dumps(_pack("de"), ensure_ascii=False, indent=2), encoding="utf-8"
    )

    assert _merge(env) == 1
    out = capsys.readouterr().out
    assert "[FAIL] de" in out
    assert "[OK] es" in out
    # Валидный язык слит, несмотря на отказ по соседнему.
    assert _read_pack(packs_dir, "es")["legal"]["tos"].startswith("# Condiciones")
    assert _read_pack(packs_dir, "de")["legal"]["tos"] is None
