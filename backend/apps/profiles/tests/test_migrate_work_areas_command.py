"""migrate_profile_geo_to_work_areas (план 11.09 §4, ADR-182): --apply по
умолчанию выключен, works_remotely -> world, однозначный city_name ->
город, неоднозначный/не найденный — не трогаем и печатаем в отчёте,
повторный прогон идемпотентен (не плодит записи)."""

from __future__ import annotations

import io

import pytest
from django.core.management import call_command

from apps.accounts.models import User
from apps.geo.models import City, CityName, Country
from apps.profiles import services
from apps.profiles.models import Profile, WorkArea

pytestmark = pytest.mark.django_db


def _make_profile(
    trust_id: str, phone: str, *, city_name: str = "", works_remotely: bool = False
) -> Profile:
    user = User.objects.create(trust_id=trust_id, phone=phone)
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility=Profile.Visibility.PUBLIC,
        city_name=city_name,
        works_remotely=works_remotely,
    )


@pytest.fixture
def country_kz() -> Country:
    return Country.objects.create(code="KZ", is_active=True)


@pytest.fixture
def country_fr() -> Country:
    return Country.objects.create(code="FR", is_active=True)


@pytest.fixture
def city_almaty(country_kz: Country) -> City:
    """Как в реальном дампе GeoNames (apps/geo/tests/data/cities15000_sample.txt):
    `name`/`name_latin` — латиницей (`Almaty`), кириллическое «Алматы» —
    ТОЛЬКО в `CityName` (подушевые имена, ADR-181). `City.name`/`name_latin`
    объявлены с коллацией "C" (apps.geo.models, докстринг «ВАЖНОЕ УТОЧНЕНИЕ»)
    — `Lower()` там не сворачивает кириллицу, поэтому точный поиск по
    кириллическому тексту обязан идти через `CityName` (без "C"), не через
    сам `City.name`."""
    city = City.objects.create(
        country=country_kz, name="Almaty", name_latin="Almaty", geonames_id=94000001
    )
    CityName.objects.create(
        city=city, locale="ru", name="Алматы", is_preferred=True, geonames_alt_name_id=94100001
    )
    return city


@pytest.fixture
def ambiguous_cities(country_kz: Country, country_fr: Country) -> list[City]:
    """Одноимённые (по кириллическому альт-имени) города в разных странах —
    «нашёлся неоднозначно»."""
    kz_city = City.objects.create(
        country=country_kz, name="Parizh", name_latin="Parizh", geonames_id=94000002
    )
    fr_city = City.objects.create(
        country=country_fr, name="Paris", name_latin="Paris", geonames_id=94000003
    )
    CityName.objects.create(
        city=kz_city, locale="ru", name="Париж", is_preferred=True, geonames_alt_name_id=94100002
    )
    CityName.objects.create(
        city=fr_city, locale="ru", name="Париж", is_preferred=True, geonames_alt_name_id=94100003
    )
    return [kz_city, fr_city]


def test_dry_run_changes_nothing(city_almaty: City):
    profile = _make_profile("trust-migrate-1", "+79990850001", city_name="Алматы")
    report = services.migrate_profile_geo_to_work_areas(apply=False)
    assert report.migrated_city == 1
    assert WorkArea.objects.filter(profile=profile).count() == 0


def test_works_remotely_becomes_world(city_almaty: City):
    profile = _make_profile(
        "trust-migrate-2", "+79990850002", works_remotely=True, city_name="где угодно"
    )
    report = services.migrate_profile_geo_to_work_areas(apply=True)
    assert report.migrated_world == 1
    area = WorkArea.objects.get(profile=profile)
    assert area.scope == WorkArea.Scope.WORLD


def test_unambiguous_city_name_migrates_to_city(city_almaty: City):
    profile = _make_profile("trust-migrate-3", "+79990850003", city_name="Алматы")
    report = services.migrate_profile_geo_to_work_areas(apply=True)
    assert report.migrated_city == 1
    area = WorkArea.objects.get(profile=profile)
    assert area.scope == WorkArea.Scope.CITY
    assert area.city_id == city_almaty.id


def test_case_insensitive_match(city_almaty: City):
    profile = _make_profile("trust-migrate-4", "+79990850004", city_name="алматы")
    services.migrate_profile_geo_to_work_areas(apply=True)
    area = WorkArea.objects.get(profile=profile)
    assert area.city_id == city_almaty.id


def test_ambiguous_city_name_left_untouched(ambiguous_cities: list[City]):
    profile = _make_profile("trust-migrate-5", "+79990850005", city_name="Париж")
    report = services.migrate_profile_geo_to_work_areas(apply=True)
    assert report.migrated_city == 0
    assert len(report.ambiguous) == 1
    assert report.ambiguous[0]["profile_id"] == str(profile.id)
    assert WorkArea.objects.filter(profile=profile).count() == 0
    profile.refresh_from_db()
    assert profile.city_name == "Париж"


def test_not_found_city_name_left_untouched():
    profile = _make_profile("trust-migrate-6", "+79990850006", city_name="Нигдеград")
    report = services.migrate_profile_geo_to_work_areas(apply=True)
    assert report.migrated_city == 0
    assert len(report.not_found) == 1
    assert report.not_found[0]["profile_id"] == str(profile.id)
    assert WorkArea.objects.filter(profile=profile).count() == 0


def test_profile_without_city_or_remote_is_not_reported():
    _make_profile("trust-migrate-7", "+79990850007")
    report = services.migrate_profile_geo_to_work_areas(apply=True)
    assert report.migrated_world == 0
    assert report.migrated_city == 0
    assert not report.ambiguous
    assert not report.not_found


def test_rerun_does_not_duplicate(city_almaty: City):
    profile = _make_profile("trust-migrate-8", "+79990850008", city_name="Алматы")
    services.migrate_profile_geo_to_work_areas(apply=True)
    second_report = services.migrate_profile_geo_to_work_areas(apply=True)
    assert second_report.migrated_city == 0
    assert second_report.already_migrated == 1
    assert WorkArea.objects.filter(profile=profile).count() == 1


def test_command_dry_run_writes_nothing_and_reports(city_almaty: City):
    profile = _make_profile("trust-migrate-9", "+79990850009", city_name="Алматы")
    out = io.StringIO()
    call_command("migrate_profile_geo_to_work_areas", stdout=out)
    assert "ВХОЛОСТУЮ" in out.getvalue()
    assert WorkArea.objects.filter(profile=profile).count() == 0


def test_command_apply_writes(city_almaty: City):
    profile = _make_profile("trust-migrate-10", "+79990850010", city_name="Алматы")
    out = io.StringIO()
    call_command("migrate_profile_geo_to_work_areas", apply=True, stdout=out)
    assert "ПРИМЕНЕНО" in out.getvalue()
    assert WorkArea.objects.filter(profile=profile).count() == 1


def test_command_reports_ambiguous_and_not_found(ambiguous_cities: list[City]):
    _make_profile("trust-migrate-11", "+79990850011", city_name="Париж")
    _make_profile("trust-migrate-12", "+79990850012", city_name="Нигдеград")
    out = io.StringIO()
    call_command("migrate_profile_geo_to_work_areas", apply=True, stdout=out)
    text = out.getvalue()
    assert "Неоднозначные" in text
    assert "Не найдены" in text
