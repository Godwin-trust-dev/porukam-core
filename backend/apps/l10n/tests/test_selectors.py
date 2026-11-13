"""Л.2 п.4 — фолбэк-цепочка «запрошенный язык → en» по импортированным
пакетам (НЕ до ru — RU-контур не тронут, common/i18n.py остаётся своим
отдельным механизмом)."""

from __future__ import annotations

import pytest

from apps.l10n import selectors, services
from apps.l10n.models import Locale

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _es_pack():
    services.import_pack(
        {
            "locale": "es",
            "name": "Español",
            "rtl": False,
            "quality": "machine",
            "pack_version": 1,
            "errors": {"otp_invalid_code": "Código incorrecto"},
            "notifications": {
                "contract.signed": {
                    "subject": "Contrato firmado",
                    "body": "Ambas partes firmaron.",
                }
            },
            "catalog": {"spheres": {"design": "Diseño"}},
            "clauses": {"K2@1": "Texto del bloque K2"},
            "legal": {"disclaimer": None, "consents": {"pd_processing": None}},
        }
    )


def test_list_enabled_locales_includes_seed_and_imported():
    codes = set(selectors.list_enabled_locales().values_list("code", flat=True))
    assert {"en", "ru", "es"} <= codes


def test_disabled_locale_is_excluded_from_list():
    Locale.objects.filter(code="es").update(enabled=False)
    codes = set(selectors.list_enabled_locales().values_list("code", flat=True))
    assert "es" not in codes


def test_is_locale_enabled():
    assert selectors.is_locale_enabled("es") is True
    assert selectors.is_locale_enabled("xx") is False


def test_get_error_title_present_key_returns_pack_text():
    assert selectors.get_error_title("otp_invalid_code", locale="es") == "Código incorrecto"


def test_get_error_title_missing_key_falls_back_to_en_pack_or_none():
    """en не импортирован в этом тесте (сид без LocalePack на en) —
    отсутствующий ключ возвращает None, вызывающая сторона (common/api/
    exceptions.py) сама решает дальнейший фолбэк на встроенный EN-реестр."""
    assert selectors.get_error_title("unknown_code", locale="es") is None


def test_get_error_title_falls_back_to_en_pack_when_imported():
    services.import_pack(
        {
            "locale": "en",
            "name": "English",
            "rtl": False,
            "quality": "canonical",
            "pack_version": 1,
            "errors": {"unknown_code": "Fallback English text"},
        }
    )
    assert selectors.get_error_title("unknown_code", locale="es") == "Fallback English text"
    assert selectors.get_error_title("unknown_code", locale="en") == "Fallback English text"


def test_get_notification_text_returns_subject_and_body():
    entry = selectors.get_notification_text("contract.signed", locale="es")
    assert entry == {"subject": "Contrato firmado", "body": "Ambas partes firmaron."}


def test_get_notification_text_missing_topic_returns_none():
    assert selectors.get_notification_text("no.such.topic", locale="es") is None


def test_get_catalog_text():
    assert selectors.get_catalog_text("spheres", "design", locale="es") == "Diseño"
    assert selectors.get_catalog_text("spheres", "unknown", locale="es") is None


def test_get_catalog_map_merges_en_under_locale():
    """ADR-097: bulk-чтение `catalog.<sub_ns>` — en-значения перекрываются
    значениями запрошенного языка, недостающие ключи остаются из en."""
    services.import_pack(
        {
            "locale": "en",
            "name": "English",
            "rtl": False,
            "quality": "canonical",
            "pack_version": 1,
            "catalog": {"spheres": {"design": "Design", "it": "IT & software"}},
        }
    )
    assert selectors.get_catalog_map("spheres", locale="es") == {
        "design": "Diseño",  # es поверх en
        "it": "IT & software",  # только en — фолбэк на уровне ключа
    }


def test_get_catalog_map_missing_namespace_or_pack_is_empty():
    # es-пакет есть (autouse-фикстура), но namespace categories в нём нет.
    assert selectors.get_catalog_map("categories", locale="es") == {}
    # fr не импортирован: цепочка fr → en, en здесь тоже не импортирован —
    # пустой словарь, без ошибок.
    assert selectors.get_catalog_map("spheres", locale="fr") == {}


def test_get_clause_text():
    assert selectors.get_clause_text("K2", 1, locale="es") == "Texto del bloque K2"
    assert selectors.get_clause_text("K2", 2, locale="es") is None


def test_get_legal_text_null_value_is_not_a_translation():
    """legal.disclaimer=null — валидно (ещё не заполнено до Ю-23), но не
    текст: селектор возвращает None, не путает null с реальным переводом."""
    assert selectors.get_legal_text("disclaimer", locale="es") is None


def test_get_legal_text_nested_group_key():
    assert selectors.get_legal_text("consents.pd_processing", locale="es") is None


def test_no_pack_for_locale_returns_none_without_error():
    assert selectors.get_error_title("otp_invalid_code", locale="fr") is None


# --- match_enabled_locale (ADR-095) -------------------------------------


@pytest.fixture
def _region_tagged_packs():
    """Региональные коды — ровно те, на которых ломался прежний резолвер:
    `Locale.code` = код пакета (`pt-BR`), а искали огрублённое `pt`."""
    for code, name in (("pt-BR", "Português (Brasil)"), ("zh-Hans", "简体中文")):
        services.import_pack(
            {
                "locale": code,
                "name": name,
                "rtl": False,
                "quality": "machine",
                "pack_version": 1,
                "errors": {},
                "notifications": {},
                "catalog": {},
                "clauses": {},
                "legal": {},
            }
        )


def test_match_enabled_locale_exact_code():
    assert selectors.match_enabled_locale("es") == "es"


def test_match_enabled_locale_is_case_insensitive(_region_tagged_packs):
    """BCP-47 регистронезависим; клиенты пишут регион как попало."""
    assert selectors.match_enabled_locale("pt-br") == "pt-BR"
    assert selectors.match_enabled_locale("PT-BR") == "pt-BR"


def test_match_enabled_locale_drops_subtags_to_find_language(_region_tagged_packs):
    """RFC 4647 lookup: `es-419` читается языком без региона."""
    assert selectors.match_enabled_locale("es-419") == "es"


def test_match_enabled_locale_finds_single_regional_variant(_region_tagged_packs):
    """Главный регресс ADR-095: `pt`/`zh` обязаны находить `pt-BR`/`zh-Hans`,
    иначе бразилец и китаец молча получали DEFAULT_LOCALE (русский)."""
    assert selectors.match_enabled_locale("pt") == "pt-BR"
    assert selectors.match_enabled_locale("zh") == "zh-Hans"


def test_match_enabled_locale_ambiguous_regional_variant_is_not_guessed():
    """Два варианта под одной подгруппой — выбирать за человека нельзя."""
    for code in ("pt-BR", "pt-PT"):
        services.import_pack(
            {
                "locale": code,
                "name": code,
                "rtl": False,
                "quality": "machine",
                "pack_version": 1,
                "errors": {},
                "notifications": {},
                "catalog": {},
                "clauses": {},
                "legal": {},
            }
        )
    assert selectors.match_enabled_locale("pt") is None


def test_match_enabled_locale_ignores_disabled(_region_tagged_packs):
    Locale.objects.filter(code="pt-BR").update(enabled=False)
    assert selectors.match_enabled_locale("pt-BR") is None
    assert selectors.match_enabled_locale("pt") is None


def test_match_enabled_locale_unknown_tag():
    assert selectors.match_enabled_locale("xx-YY") is None
    assert selectors.match_enabled_locale("") is None
