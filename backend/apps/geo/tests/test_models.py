"""БД-инварианты apps.geo — на живом PostgreSQL (CLAUDE.md: CHECK/EXCLUDE/
уникальность не проверяются на sqlite; в этом проекте DATABASE_URL всегда
Postgres, sqlite не используется вовсе)."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.geo.models import City, Country, Region

pytestmark = pytest.mark.django_db


@pytest.fixture
def kz() -> Country:
    return Country.objects.create(code="KZ")


@pytest.fixture
def ru() -> Country:
    return Country.objects.create(code="RU")


def test_region_code_unique_within_country(kz):
    Region.objects.create(country=kz, code="02", name="Almaty", name_latin="Almaty")
    with pytest.raises(IntegrityError), transaction.atomic():
        Region.objects.create(country=kz, code="02", name="Almaty Dup", name_latin="Almaty Dup")


def test_region_code_can_repeat_across_countries(kz, ru):
    Region.objects.create(country=kz, code="02", name="Almaty", name_latin="Almaty")
    # Тот же код "02" у другой страны — не конфликт (уникальность ТОЛЬКО
    # в паре со страной, models.Region).
    Region.objects.create(country=ru, code="02", name="Some Oblast", name_latin="Some Oblast")


def test_region_geonames_id_unique(kz, ru):
    Region.objects.create(
        country=kz, code="02", name="Almaty", name_latin="Almaty", geonames_id=1526395
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        Region.objects.create(
            country=ru, code="99", name="Dup", name_latin="Dup", geonames_id=1526395
        )


def test_region_geonames_id_null_does_not_conflict(kz, ru):
    # geonames_id nullable — несколько NULL допустимы (обычная Postgres-
    # семантика уникального индекса: NULL != NULL).
    Region.objects.create(country=kz, code="02", name="Almaty", name_latin="Almaty")
    Region.objects.create(country=ru, code="77", name="Tver", name_latin="Tver")


def test_city_geonames_id_unique(kz):
    City.objects.create(country=kz, name="Almaty", name_latin="Almaty", geonames_id=1526384)
    with pytest.raises(IntegrityError), transaction.atomic():
        City.objects.create(country=kz, name="Dup", name_latin="Dup", geonames_id=1526384)


def test_city_region_can_be_null(kz):
    city = City.objects.create(country=kz, name="Almaty", name_latin="Almaty", geonames_id=1)
    assert city.region is None


def test_country_code_is_primary_key(kz):
    assert Country.objects.filter(pk="KZ").exists()
    with pytest.raises(IntegrityError), transaction.atomic():
        Country.objects.create(code="KZ")
