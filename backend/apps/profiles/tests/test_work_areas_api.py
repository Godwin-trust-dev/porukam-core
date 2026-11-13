"""GET/PUT /v1/profiles/{id}/work-areas (план 11.09 §4, ADR-182): выдача на
языке зрителя, 422 по кодам ошибок, 403 для чужого профиля."""

from __future__ import annotations

import itertools

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.geo.models import City, Country, Region
from apps.profiles.models import Profile, WorkArea

pytestmark = pytest.mark.django_db

_user_seq = itertools.count(1)


def _client(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def owner() -> User:
    return User.objects.create(trust_id="trust-work-area-api-1", phone="+79990870001")


@pytest.fixture
def stranger() -> User:
    return User.objects.create(trust_id="trust-work-area-api-2", phone="+79990870002")


@pytest.fixture
def profile(owner: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=owner, profile_visibility=Profile.Visibility.PUBLIC
    )


@pytest.fixture
def country_kz() -> Country:
    return Country.objects.create(code="KZ", is_active=True)


@pytest.fixture
def region_almaty(country_kz: Country) -> Region:
    return Region.objects.create(
        country=country_kz,
        code="02",
        name="Алматинская область",
        name_latin="Almaty region",
        name_i18n={"ru": "Алматинская область", "en": "Almaty Region"},
    )


@pytest.fixture
def city_almaty(country_kz: Country, region_almaty: Region) -> City:
    return City.objects.create(
        country=country_kz,
        region=region_almaty,
        name="Алматы",
        name_latin="Almaty",
        geonames_id=93000001,
        name_i18n={"ru": "Алматы", "en": "Almaty"},
    )


def test_get_requires_authentication(profile: Profile):
    resp = APIClient().get(f"/v1/profiles/{profile.id}/work-areas")
    assert resp.status_code == 401


def test_get_empty_for_fresh_profile(profile: Profile, owner: User):
    resp = _client(owner).get(f"/v1/profiles/{profile.id}/work-areas")
    assert resp.status_code == 200, resp.content
    assert resp.data == []


def test_get_denied_for_stranger(profile: Profile, stranger: User):
    resp = _client(stranger).get(f"/v1/profiles/{profile.id}/work-areas")
    assert resp.status_code == 403, resp.content


def test_put_denied_for_stranger(profile: Profile, stranger: User):
    resp = _client(stranger).put(
        f"/v1/profiles/{profile.id}/work-areas", [{"scope": "world"}], format="json"
    )
    assert resp.status_code == 403, resp.content


def test_put_world_scope(profile: Profile, owner: User):
    resp = _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas", [{"scope": "world"}], format="json"
    )
    assert resp.status_code == 200, resp.content
    assert len(resp.data) == 1
    assert resp.data[0]["scope"] == "world"
    assert resp.data[0]["location"] is None


def test_put_country_scope_returns_code_without_display_name(
    profile: Profile, owner: User, country_kz: Country
):
    resp = _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "country", "country": "kz"}],
        format="json",
    )
    assert resp.status_code == 200, resp.content
    location = resp.data[0]["location"]
    assert location == {"code": "KZ"}


def test_put_city_scope_locale_ru(profile: Profile, owner: User, city_almaty: City):
    resp = _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "city", "city": city_almaty.id}],
        format="json",
        HTTP_ACCEPT_LANGUAGE="ru",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data[0]["location"]["display_name"] == "Алматы"


def test_put_city_scope_locale_en(profile: Profile, owner: User, city_almaty: City):
    resp = _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "city", "city": city_almaty.id}],
        format="json",
        HTTP_ACCEPT_LANGUAGE="en",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data[0]["location"]["display_name"] == "Almaty"


def test_get_after_put_is_locale_aware(profile: Profile, owner: User, region_almaty: Region):
    _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "region", "region": f"KZ-{region_almaty.code}"}],
        format="json",
    )
    resp = _client(owner).get(f"/v1/profiles/{profile.id}/work-areas", HTTP_ACCEPT_LANGUAGE="en")
    assert resp.status_code == 200, resp.content
    assert resp.data[0]["location"]["display_name"] == "Almaty Region"


def test_put_unknown_city_returns_422_with_code(profile: Profile, owner: User):
    resp = _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "city", "city": 999999}],
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "work_area_unknown_location"


def test_put_city_not_in_given_country_returns_422_mismatch(
    profile: Profile, owner: User, city_almaty: City
):
    other = Country.objects.create(code="RU", is_active=True)
    resp = _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "city", "city": city_almaty.id, "country": other.code}],
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "work_area_location_mismatch"


def test_put_over_limit_returns_422(profile: Profile, owner: User):
    codes = ["KZ", "RU", "US", "DE", "BY", "AM"]
    for code in codes:
        Country.objects.get_or_create(code=code, defaults={"is_active": True})
    items = [{"scope": "country", "country": code} for code in codes]
    resp = _client(owner).put(f"/v1/profiles/{profile.id}/work-areas", items, format="json")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "work_area_limit"


def test_put_replaces_previous_list(profile: Profile, owner: User, city_almaty: City):
    other_country = Country.objects.create(code="RU", is_active=True)
    _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "city", "city": city_almaty.id}],
        format="json",
    )
    resp = _client(owner).put(
        f"/v1/profiles/{profile.id}/work-areas",
        [{"scope": "country", "country": other_country.code}],
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert WorkArea.objects.filter(profile=profile).count() == 1
    assert resp.data[0]["scope"] == "country"
