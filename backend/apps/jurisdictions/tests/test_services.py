import pytest

from apps.jurisdictions.models import JurisdictionConfig
from apps.jurisdictions.services import CurrencyNotAllowedError, assert_currency_allowed


@pytest.fixture
def ru_jurisdiction(db) -> JurisdictionConfig:
    """RU — сид-данные миграции (0004_seed_ru_and_global, ГВ.1), не ad hoc
    фикстура: тест тем самым проверяет реальный контур, а не его копию."""
    return JurisdictionConfig.objects.get(country_code="RU")


def test_allowed_currency_passes(ru_jurisdiction):
    assert_currency_allowed(ru_jurisdiction, "RUB")  # не бросает исключение


def test_currency_outside_allowed_is_rejected(ru_jurisdiction):
    with pytest.raises(CurrencyNotAllowedError):
        assert_currency_allowed(ru_jurisdiction, "USD")


def test_ru_contour_unaffected_by_global_wave_currency_widening(ru_jurisdiction):
    """✅ ГВ.1: RU-контур работает без изменений — расширение валют GLOBAL
    (USD/EUR) никак не задевает allowed_currency_codes контура RU."""
    assert ru_jurisdiction.allowed_currency_codes == ["RUB"]
    with pytest.raises(CurrencyNotAllowedError):
        assert_currency_allowed(ru_jurisdiction, "EUR")


@pytest.mark.django_db
def test_global_contour_accepts_currencies_beyond_rub():
    """✅ ГВ.1: в GLOBAL-контуре доступны валюты помимо RUB."""
    global_jurisdiction = JurisdictionConfig.objects.get(is_global_default=True)
    assert_currency_allowed(global_jurisdiction, "USD")
    assert_currency_allowed(global_jurisdiction, "EUR")
    assert_currency_allowed(global_jurisdiction, "RUB")


@pytest.mark.django_db
def test_global_contour_profile_matches_global_wave_table():
    """✅ ГВ.1 профиль (постановка §2): юрсилы нет, налогов нет, SMS
    выключен, платежи сторон — вне платформы."""
    global_jurisdiction = JurisdictionConfig.objects.get(is_global_default=True)
    assert global_jurisdiction.legal_force_available is False
    assert global_jurisdiction.tax_guidance_available is False
    assert global_jurisdiction.platform_mediates_payment is False
    assert global_jurisdiction.sms_channel_enabled is False
