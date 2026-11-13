"""Метрика «поисков с фильтром» (ADR-186, часть 7 плана 11.09) —
бэкендная половина: `GET /v1/dashboard/search` (ветка `catalog`, ADR-184)
пишет факт поиска в `apps.analytics` через `apps.dashboards.services`.

Что проверяется здесь (сам подсчёт и разрезы — в
`apps/analytics/tests/test_catalog_search_metric.py`): какой именно факт
распознаёт вьюха по параметрам запроса — поиск без фильтра НЕ считается «с
фильтром», каждый вид фильтра распознаётся отдельно, сочетание — как одна
запись со всеми флагами сразу, а пагинация того же поиска новой записи не
создаёт (CLAUDE.md: каждый запрет/переход — отдельным тестом)."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.analytics.models import CatalogSearchEvent
from apps.geo.models import City, Country, Region
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_counter = 0

# Дедупликация (ADR-186) живёт в общем Redis-кеше по ключу, вычисленному ИЗ
# user_id — очищать кеш между тестами не нужно: `User.id` (uuid7) свежий у
# КАЖДОГО пользователя, которого создают фикстуры этого файла, поэтому ключ
# дедупликации никогда не повторяется и не сталкивается ни с прошлым
# прогоном, ни с соседним `pytest-xdist`-воркером (`-n auto`, ADR-145).


def _user() -> User:
    global _counter
    _counter += 1
    return User.objects.create(
        trust_id=f"trust-search-metric-{_counter:04d}",
        phone=f"+7999088{_counter:04d}",
        discoverable_by_handle=True,
    )


def _profile() -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=_user(),
        profile_visibility=Profile.Visibility.PUBLIC,
    )


def _client() -> APIClient:
    client = APIClient()
    client.force_authenticate(user=_user())
    return client


@pytest.fixture
def kz() -> Country:
    return Country.objects.create(code="KZ", is_active=True)


@pytest.fixture
def almaty_region(kz: Country) -> Region:
    return Region.objects.create(
        country=kz, code="02", name="Алматинская область", name_latin="Almaty region"
    )


@pytest.fixture
def almaty_city(kz: Country, almaty_region: Region) -> City:
    return City.objects.create(
        country=kz, region=almaty_region, name="Алматы", name_latin="Almaty", geonames_id=501
    )


def _only_event() -> CatalogSearchEvent:
    return CatalogSearchEvent.objects.get()


# --------------------------------------------------------------------------
# Что вообще считается «поиском» и «поиском с фильтром»
# --------------------------------------------------------------------------
def test_plain_handle_lookup_without_catalog_params_records_nothing():
    """🚫 `q=`-режим (адресный лукап) — не каталожный поиск (ADR-184): ветка
    `catalog` не считается вовсе, метрика не пишется."""
    resp = _client().get("/v1/dashboard/search", {"q": "whatever-nobody-has"})
    assert resp.status_code == 200
    assert not CatalogSearchEvent.objects.exists()


def test_catalog_without_any_filter_is_recorded_as_unfiltered():
    """✅ `catalog=1` без единого фильтра («весь мир») — поиск состоялся, но
    БЕЗ фильтра: все три флага пустые."""
    resp = _client().get("/v1/dashboard/search", {"catalog": "1"})
    assert resp.status_code == 200
    event = _only_event()
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("none", False, False)


# --------------------------------------------------------------------------
# Каждый вид фильтра — отдельно
# --------------------------------------------------------------------------
def test_country_filter_is_recorded_at_country_level(kz: Country):
    resp = _client().get("/v1/dashboard/search", {"country": "KZ"})
    assert resp.status_code == 200
    event = _only_event()
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("country", False, False)


def test_region_filter_is_recorded_at_region_level(almaty_region: Region):
    resp = _client().get("/v1/dashboard/search", {"region": "KZ-02"})
    assert resp.status_code == 200
    event = _only_event()
    assert event.geo_level == "region"


def test_city_filter_is_recorded_at_city_level(almaty_city: City):
    resp = _client().get("/v1/dashboard/search", {"city": str(almaty_city.id)})
    assert resp.status_code == 200
    event = _only_event()
    assert event.geo_level == "city"


def test_deepest_geo_level_wins_when_several_are_sent(almaty_city: City, almaty_region: Region):
    """Тот же принцип, что в самом фильтре (ADR-184): если пришли и страна, и
    город, метрика фиксирует именно ГОРОД — уровень, который фактически
    применился, а не первый попавшийся параметр."""
    resp = _client().get("/v1/dashboard/search", {"country": "KZ", "city": str(almaty_city.id)})
    assert resp.status_code == 200
    assert _only_event().geo_level == "city"


def test_sphere_filter_alone_is_recorded():
    resp = _client().get("/v1/dashboard/search", {"sphere": "cleaning"})
    assert resp.status_code == 200
    event = _only_event()
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("none", True, False)


def test_experience_min_filter_alone_is_recorded():
    resp = _client().get("/v1/dashboard/search", {"experience_min": "3"})
    assert resp.status_code == 200
    event = _only_event()
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("none", False, True)


def test_experience_min_zero_still_counts_as_a_filter():
    """✅ ADR-184: ноль — валидный порог опыта, то есть фильтр ПРИМЕНЁН
    (человек явно попросил «от нуля»), а не «фильтра не было»."""
    resp = _client().get("/v1/dashboard/search", {"experience_min": "0"})
    assert resp.status_code == 200
    assert _only_event().has_experience is True


def test_has_experience_flag_alone_is_recorded():
    resp = _client().get("/v1/dashboard/search", {"has_experience": "1"})
    assert resp.status_code == 200
    assert _only_event().has_experience is True


# --------------------------------------------------------------------------
# Сочетание фильтров — одна запись со всеми флагами сразу
# --------------------------------------------------------------------------
def test_combination_of_filters_is_recorded_as_one_event(almaty_city: City):
    resp = _client().get(
        "/v1/dashboard/search",
        {"city": str(almaty_city.id), "sphere": "cleaning", "experience_min": "2"},
    )
    assert resp.status_code == 200
    event = _only_event()
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("city", True, True)


# --------------------------------------------------------------------------
# Пагинация того же поиска не накручивает счётчик
# --------------------------------------------------------------------------
def test_pagination_with_cursor_does_not_record_a_new_search():
    """🚫 Запрос с `cursor` — продолжение уже случившегося поиска
    (перелистывание страниц), а не новый: вторая запись не создаётся."""
    for _ in range(3):
        _profile()
    client = _client()
    first = client.get("/v1/dashboard/search", {"catalog": "1", "limit": "1"})
    assert first.status_code == 200
    cursor = first.data["catalog"]["next_cursor"]
    assert cursor is not None  # предпосылка теста: есть что перелистывать
    assert CatalogSearchEvent.objects.count() == 1

    second = client.get("/v1/dashboard/search", {"catalog": "1", "limit": "1", "cursor": cursor})
    assert second.status_code == 200
    assert CatalogSearchEvent.objects.count() == 1  # не выросло


def test_invalid_catalog_request_records_nothing():
    """🚫 Ошибка валидации (400) — поиск не состоялся, писать нечего."""
    resp = _client().get("/v1/dashboard/search", {"country": "kazakhstan"})
    assert resp.status_code == 400
    assert not CatalogSearchEvent.objects.exists()


# --------------------------------------------------------------------------
# Отсутствие персональных данных на уровне API (не только модели)
# --------------------------------------------------------------------------
def test_recorded_event_carries_no_identifiers():
    """✅ Сквозная проверка от HTTP-запроса до записи: в ней нет ни
    идентификатора искавшего, ни значений фильтра (кода страны, id города,
    кода сферы) — только коды уровня и булевы флаги."""
    resp = _client().get(
        "/v1/dashboard/search", {"country": "KZ", "sphere": "cleaning", "experience_min": "1"}
    )
    assert resp.status_code == 200
    event = _only_event()
    field_names = {f.name for f in CatalogSearchEvent._meta.get_fields()}
    assert not (
        field_names & {"user", "user_id", "country", "region", "city", "sphere", "sphere_codes"}
    )
    assert event.geo_level == "country"
