import pytest

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE, JurisdictionConfig
from apps.jurisdictions.selectors import (
    NoGlobalDefaultConfiguredError,
    get_global_default_jurisdiction,
    resolve_jurisdiction,
    resolve_locale,
    suggest_currency_code,
)

pytestmark = pytest.mark.django_db


def test_suggest_currency_code_substitutes_the_jurisdiction_default():
    ru_jurisdiction = JurisdictionConfig.objects.get(country_code="RU")
    assert suggest_currency_code(ru_jurisdiction) == "RUB"


def test_get_global_default_jurisdiction_returns_the_seeded_global_row():
    jurisdiction = get_global_default_jurisdiction()
    assert jurisdiction.country_code == GLOBAL_COUNTRY_CODE
    assert jurisdiction.is_global_default is True


def test_get_global_default_jurisdiction_raises_when_none_configured():
    JurisdictionConfig.objects.filter(is_global_default=True).delete()
    with pytest.raises(NoGlobalDefaultConfiguredError):
        get_global_default_jurisdiction()


def test_resolve_jurisdiction_for_ru_country_code_returns_ru():
    """✅ ГВ.1: RU-пользователь — RU."""
    jurisdiction = resolve_jurisdiction("RU")
    assert jurisdiction.country_code == "RU"
    assert jurisdiction.is_global_default is False


def test_resolve_jurisdiction_without_country_falls_back_to_global():
    """✅ ГВ.1: пользователь без страны получает контур GLOBAL."""
    jurisdiction = resolve_jurisdiction(None)
    assert jurisdiction.country_code == GLOBAL_COUNTRY_CODE


def test_resolve_jurisdiction_with_unplugged_country_falls_back_to_global():
    """✅ ГВ.1: пользователь со страной без плагина получает контур GLOBAL."""
    jurisdiction = resolve_jurisdiction("DE")
    assert jurisdiction.country_code == GLOBAL_COUNTRY_CODE


def test_resolve_jurisdiction_with_empty_string_falls_back_to_global():
    jurisdiction = resolve_jurisdiction("")
    assert jurisdiction.country_code == GLOBAL_COUNTRY_CODE


def test_resolve_jurisdiction_with_global_literal_returns_global():
    jurisdiction = resolve_jurisdiction(GLOBAL_COUNTRY_CODE)
    assert jurisdiction.country_code == GLOBAL_COUNTRY_CODE


# --- Локаль контура (ГВ.5, docs/tasks/global-wave.md, ADR-075) ------------


def test_resolve_locale_for_ru_is_ru():
    assert resolve_locale("RU") == "ru"


def test_resolve_locale_for_global_is_en():
    """✅ ГВ.5: GLOBAL-пользователь получает EN."""
    assert resolve_locale(GLOBAL_COUNTRY_CODE) == "en"


def test_resolve_locale_without_country_falls_back_to_global_en():
    """✅ ГВ.5: пользователь без страны (и со страной без плагина) — EN,
    тем же fallback-путём, что и резолвер контура."""
    assert resolve_locale(None) == "en"
    assert resolve_locale("DE") == "en"
