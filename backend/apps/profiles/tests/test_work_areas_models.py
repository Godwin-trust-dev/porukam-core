"""БД-инварианты WorkArea — на живом PostgreSQL (план 11.09 §4, ADR-182):
CheckConstraint «у масштаба заполнен ровно свой уровень» и частичные
UniqueConstraint «без дублей одного места на профиль»."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.models import User
from apps.geo.models import City, Country, Region
from apps.profiles.models import Profile, WorkArea

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-work-area-model-1", phone="+79990810001")


@pytest.fixture
def profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=user, profile_visibility=Profile.Visibility.PUBLIC
    )


@pytest.fixture
def country_kz() -> Country:
    return Country.objects.create(code="KZ", is_active=True)


@pytest.fixture
def region_kz(country_kz: Country) -> Region:
    return Region.objects.create(
        country=country_kz, code="02", name="Алматинская область", name_latin="Almaty region"
    )


@pytest.fixture
def city_almaty(country_kz: Country, region_kz: Region) -> City:
    return City.objects.create(
        country=country_kz,
        region=region_kz,
        name="Алматы",
        name_latin="Almaty",
        geonames_id=91000001,
    )


# --- work_area_scope_matches_level ------------------------------------------


def test_world_scope_with_country_rejected(profile: Profile, country_kz: Country):
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.WORLD, country=country_kz)


def test_country_scope_without_country_rejected(profile: Profile):
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.COUNTRY)


def test_country_scope_with_region_rejected(
    profile: Profile, country_kz: Country, region_kz: Region
):
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(
            profile=profile, scope=WorkArea.Scope.COUNTRY, country=country_kz, region=region_kz
        )


def test_region_scope_without_region_rejected(profile: Profile):
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.REGION)


def test_city_scope_without_city_rejected(profile: Profile):
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.CITY)


def test_city_scope_with_country_also_set_rejected(
    profile: Profile, country_kz: Country, city_almaty: City
):
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(
            profile=profile, scope=WorkArea.Scope.CITY, country=country_kz, city=city_almaty
        )


def test_world_scope_alone_is_allowed(profile: Profile):
    area = WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.WORLD)
    assert area.pk is not None


def test_city_scope_alone_is_allowed(profile: Profile, city_almaty: City):
    area = WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.CITY, city=city_almaty)
    assert area.pk is not None


# --- дубли одного места на профиль (частичные UniqueConstraint) ------------


def test_duplicate_world_per_profile_rejected(profile: Profile):
    WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.WORLD)
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.WORLD)


def test_duplicate_country_per_profile_rejected(profile: Profile, country_kz: Country):
    WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.COUNTRY, country=country_kz)
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.COUNTRY, country=country_kz)


def test_duplicate_region_per_profile_rejected(profile: Profile, region_kz: Region):
    WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.REGION, region=region_kz)
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.REGION, region=region_kz)


def test_duplicate_city_per_profile_rejected(profile: Profile, city_almaty: City):
    WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.CITY, city=city_almaty)
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.CITY, city=city_almaty)


def test_same_city_allowed_for_different_profiles(city_almaty: City):
    """Уникальность — В ПАРЕ с профилем, не глобально: разные люди могут
    заявить один и тот же город."""
    other_user = User.objects.create(trust_id="trust-work-area-model-2", phone="+79990810002")
    other_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=other_user,
        profile_visibility=Profile.Visibility.PUBLIC,
    )
    WorkArea.objects.create(profile=other_profile, scope=WorkArea.Scope.CITY, city=city_almaty)


def test_different_scopes_for_same_profile_allowed(profile: Profile, city_almaty: City):
    """Не «одна запись на профиль» — «одно место на масштаб»: город и
    страна одновременно — не дубль."""
    WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.CITY, city=city_almaty)
    area = WorkArea.objects.create(
        profile=profile, scope=WorkArea.Scope.COUNTRY, country=city_almaty.country
    )
    assert area.pk is not None
