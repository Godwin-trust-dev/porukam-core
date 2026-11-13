"""Целостность сид-миграции 0004_seed_ru_and_global (ГВ.1,
docs/tasks/global-wave.md) — данные, не логика резолвера/сервисов
(см. test_selectors.py / test_services.py)."""

import pytest

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE, JurisdictionConfig

pytestmark = pytest.mark.django_db


def test_ru_seed_row_matches_pre_global_wave_configuration():
    """RU-контур работает без изменений — точный снимок того, что было
    задано ad hoc в тестах до ГВ.1."""
    ru = JurisdictionConfig.objects.get(country_code="RU")
    assert ru.default_currency_code == "RUB"
    assert ru.allowed_currency_codes == ["RUB"]
    assert ru.is_global_default is False


def test_global_seed_row_profile():
    global_jurisdiction = JurisdictionConfig.objects.get(country_code=GLOBAL_COUNTRY_CODE)
    assert global_jurisdiction.is_global_default is True
    assert global_jurisdiction.default_currency_code in global_jurisdiction.allowed_currency_codes
    assert set(global_jurisdiction.allowed_currency_codes) >= {"USD", "EUR", "RUB"}
    assert global_jurisdiction.legal_force_available is False
    assert global_jurisdiction.tax_guidance_available is False
    assert global_jurisdiction.platform_mediates_payment is False
    assert global_jurisdiction.sms_channel_enabled is False


def test_exactly_two_seeded_jurisdictions():
    """До ГВ.2–ГВ.5 никакой другой страновой плагин не появляется."""
    assert set(JurisdictionConfig.objects.values_list("country_code", flat=True)) == {
        "RU",
        GLOBAL_COUNTRY_CODE,
    }
