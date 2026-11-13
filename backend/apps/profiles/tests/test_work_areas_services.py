"""services.replace_work_areas (план 11.09 §4, ADR-182): валидация состава
полей под scope, существование/внутренняя согласованность ссылки на
apps.geo, лимит WORK_AREA_MAX, идемпотентная полная замена, право."""

from __future__ import annotations

import pytest

from apps.accounts.models import User
from apps.geo.models import City, Country, Region
from apps.profiles import services
from apps.profiles.models import Profile, WorkArea

pytestmark = pytest.mark.django_db


@pytest.fixture
def owner() -> User:
    return User.objects.create(trust_id="trust-work-area-svc-1", phone="+79990820001")


@pytest.fixture
def stranger() -> User:
    return User.objects.create(trust_id="trust-work-area-svc-2", phone="+79990820002")


@pytest.fixture
def profile(owner: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=owner, profile_visibility=Profile.Visibility.PUBLIC
    )


@pytest.fixture
def country_kz() -> Country:
    return Country.objects.create(code="KZ", is_active=True)


@pytest.fixture
def country_ru() -> Country:
    return Country.objects.create(code="RU", is_active=True)


@pytest.fixture
def region_almaty(country_kz: Country) -> Region:
    return Region.objects.create(
        country=country_kz, code="02", name="Алматинская область", name_latin="Almaty region"
    )


@pytest.fixture
def region_other_kz(country_kz: Country) -> Region:
    return Region.objects.create(
        country=country_kz, code="01", name="Акмолинская область", name_latin="Akmola region"
    )


@pytest.fixture
def city_almaty(country_kz: Country, region_almaty: Region) -> City:
    return City.objects.create(
        country=country_kz,
        region=region_almaty,
        name="Алматы",
        name_latin="Almaty",
        geonames_id=92000001,
    )


@pytest.fixture
def city_moscow(country_ru: Country) -> City:
    return City.objects.create(
        country=country_ru, name="Москва", name_latin="Moskva", geonames_id=92000002
    )


def test_replace_over_limit_rejected(profile: Profile, owner: User):
    codes = ("KZ", "RU", "US", "DE", "BY", "AM")
    for code in codes:
        Country.objects.get_or_create(code=code, defaults={"is_active": True})
    items = [{"scope": WorkArea.Scope.COUNTRY, "country": code} for code in codes]
    with pytest.raises(services.WorkAreaLimitError):
        services.replace_work_areas(profile, owner, items)


def test_replace_city_not_in_given_region_rejected(
    profile: Profile, owner: User, city_almaty: City, region_other_kz: Region
):
    items = [
        {
            "scope": WorkArea.Scope.CITY,
            "city": city_almaty.id,
            "region": f"{region_other_kz.country_id}-{region_other_kz.code}",
        }
    ]
    with pytest.raises(services.WorkAreaLocationMismatchError):
        services.replace_work_areas(profile, owner, items)


def test_replace_city_not_in_given_country_rejected(
    profile: Profile, owner: User, city_almaty: City, country_ru: Country
):
    items = [{"scope": WorkArea.Scope.CITY, "city": city_almaty.id, "country": "RU"}]
    with pytest.raises(services.WorkAreaLocationMismatchError):
        services.replace_work_areas(profile, owner, items)


def test_replace_city_in_matching_region_is_allowed(
    profile: Profile, owner: User, city_almaty: City, region_almaty: Region
):
    items = [
        {
            "scope": WorkArea.Scope.CITY,
            "city": city_almaty.id,
            "region": f"{region_almaty.country_id}-{region_almaty.code}",
        }
    ]
    areas = services.replace_work_areas(profile, owner, items)
    assert len(areas) == 1
    assert areas[0].city_id == city_almaty.id


def test_replace_unknown_city_rejected(profile: Profile, owner: User):
    with pytest.raises(services.WorkAreaUnknownLocationError):
        services.replace_work_areas(
            profile, owner, [{"scope": WorkArea.Scope.CITY, "city": 999999}]
        )


def test_replace_unknown_country_rejected(profile: Profile, owner: User):
    with pytest.raises(services.WorkAreaUnknownLocationError):
        services.replace_work_areas(
            profile, owner, [{"scope": WorkArea.Scope.COUNTRY, "country": "ZZ"}]
        )


def test_replace_invalid_region_code_rejected(profile: Profile, owner: User):
    with pytest.raises(services.WorkAreaInvalidPayloadError):
        services.replace_work_areas(
            profile, owner, [{"scope": WorkArea.Scope.REGION, "region": "not-a-code"}]
        )


def test_replace_world_with_extra_ref_rejected(profile: Profile, owner: User, country_kz: Country):
    with pytest.raises(services.WorkAreaInvalidPayloadError):
        services.replace_work_areas(
            profile, owner, [{"scope": WorkArea.Scope.WORLD, "country": "KZ"}]
        )


def test_replace_duplicate_in_request_rejected(profile: Profile, owner: User, country_kz: Country):
    items = [
        {"scope": WorkArea.Scope.COUNTRY, "country": "KZ"},
        {"scope": WorkArea.Scope.COUNTRY, "country": "kz"},
    ]
    with pytest.raises(services.WorkAreaDuplicateError):
        services.replace_work_areas(profile, owner, items)


def test_replace_is_idempotent_by_content(
    profile: Profile, owner: User, city_almaty: City, city_moscow: City
):
    items = [
        {"scope": WorkArea.Scope.CITY, "city": city_almaty.id},
        {"scope": WorkArea.Scope.CITY, "city": city_moscow.id},
    ]
    first = services.replace_work_areas(profile, owner, items)
    second = services.replace_work_areas(profile, owner, items)
    assert len(first) == len(second) == 2
    assert WorkArea.objects.filter(profile=profile).count() == 2


def test_replace_fully_swaps_previous_list(
    profile: Profile, owner: User, city_almaty: City, city_moscow: City
):
    services.replace_work_areas(
        profile, owner, [{"scope": WorkArea.Scope.CITY, "city": city_almaty.id}]
    )
    services.replace_work_areas(
        profile, owner, [{"scope": WorkArea.Scope.CITY, "city": city_moscow.id}]
    )
    remaining = list(WorkArea.objects.filter(profile=profile))
    assert len(remaining) == 1
    assert remaining[0].city_id == city_moscow.id


def test_replace_empty_list_clears_all(profile: Profile, owner: User, city_almaty: City):
    services.replace_work_areas(
        profile, owner, [{"scope": WorkArea.Scope.CITY, "city": city_almaty.id}]
    )
    services.replace_work_areas(profile, owner, [])
    assert WorkArea.objects.filter(profile=profile).count() == 0


def test_replace_denied_for_stranger(profile: Profile, stranger: User):
    with pytest.raises(services.ProfilePermissionDeniedError):
        services.replace_work_areas(profile, stranger, [{"scope": WorkArea.Scope.WORLD}])


def test_assert_can_edit_profile_denied_for_stranger(profile: Profile, stranger: User):
    with pytest.raises(services.ProfilePermissionDeniedError):
        services.assert_can_edit_profile(profile, stranger)


def test_world_scope_created(profile: Profile, owner: User):
    areas = services.replace_work_areas(profile, owner, [{"scope": WorkArea.Scope.WORLD}])
    assert len(areas) == 1
    assert areas[0].scope == WorkArea.Scope.WORLD
    assert areas[0].country_id is None
    assert areas[0].region_id is None
    assert areas[0].city_id is None
