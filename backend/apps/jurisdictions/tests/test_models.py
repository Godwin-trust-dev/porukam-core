import pytest
from django.db import IntegrityError, transaction

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE, JurisdictionConfig

# RU и GLOBAL — сид-данные миграции (0004_seed_ru_and_global, ГВ.1), поэтому
# тесты CHECK-констрейнта, не завязанные на конкретный контур, используют
# ещё не занятый код страны, чтобы не упереться в PK-коллизию с сидом.
_UNSEEDED_COUNTRY_CODE = "DE"


@pytest.mark.django_db
def test_default_currency_must_be_in_allowed_currencies():
    """CHECK-констрейнт БД (миграция 0002, живой PostgreSQL) — не app-слой."""
    with pytest.raises(IntegrityError), transaction.atomic():
        JurisdictionConfig.objects.create(
            country_code=_UNSEEDED_COUNTRY_CODE,
            default_currency_code="USD",
            allowed_currency_codes=["RUB"],
        )


@pytest.mark.django_db
def test_default_currency_inside_allowed_currencies_is_accepted():
    jurisdiction = JurisdictionConfig.objects.create(
        country_code=_UNSEEDED_COUNTRY_CODE,
        default_currency_code="RUB",
        allowed_currency_codes=["RUB"],
    )
    assert jurisdiction.default_currency_code == "RUB"


@pytest.mark.django_db
def test_only_one_global_default_jurisdiction_allowed():
    """Констрейнт БД (миграция 0003): вторую is_global_default=True строку
    завести нельзя — GLOBAL (сид 0004) уже занимает единственное место."""
    with pytest.raises(IntegrityError), transaction.atomic():
        JurisdictionConfig.objects.create(
            country_code=_UNSEEDED_COUNTRY_CODE,
            default_currency_code="RUB",
            allowed_currency_codes=["RUB"],
            is_global_default=True,
        )


@pytest.mark.django_db
def test_global_seed_row_is_the_sole_global_default():
    global_jurisdiction = JurisdictionConfig.objects.get(country_code=GLOBAL_COUNTRY_CODE)
    assert global_jurisdiction.is_global_default is True
    assert JurisdictionConfig.objects.filter(is_global_default=True).count() == 1
