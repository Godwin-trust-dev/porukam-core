"""GET /v1/geo/countries|regions|cities — авторизованный доступ, фильтры на
любом уровне, пагинация и лимиты (план 11.09 §4)."""

from __future__ import annotations

import itertools

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.geo import selectors
from apps.geo.models import City

pytestmark = pytest.mark.django_db

_user_seq = itertools.count(1)


def _client() -> APIClient:
    # get_user_model() — а не apps.accounts.models.User: apps.geo нижний
    # слой (CLAUDE.md, import-linter), тестам тоже нельзя статически
    # импортировать apps.accounts. Каждый вызов — СВОЙ пользователь (счётчик
    # в trust_id): тесты дёргают _client() несколько раз за один тест
    # (несколько запросов одним сценарием), а trust_id уникален в БД.
    n = next(_user_seq)
    user = get_user_model().objects.create(trust_id=f"trust-geo-api-{n}", phone=f"+7999081{n:04d}")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_countries_requires_authentication(geo_fixture):
    resp = APIClient().get("/v1/geo/countries")
    assert resp.status_code == 401


def test_countries_returns_codes(geo_fixture):
    resp = _client().get("/v1/geo/countries")
    assert resp.status_code == 200
    codes = {row["code"] for row in resp.data}
    assert codes == {"AL", "BY", "DE", "KZ", "RU", "US"}


def test_regions_requires_authentication(geo_fixture):
    resp = APIClient().get("/v1/geo/regions")
    assert resp.status_code == 401


def test_regions_filter_by_country(geo_fixture):
    resp = _client().get("/v1/geo/regions", {"country": "kz"})
    assert resp.status_code == 200
    codes = {row["code"] for row in resp.data}
    assert codes == {"KZ-02", "KZ-05"}


def test_regions_filter_by_q_any_script(geo_fixture):
    resp = _client().get("/v1/geo/regions", {"q": "diber"})
    assert resp.status_code == 200
    assert [row["code"] for row in resp.data] == ["AL-41"]


def test_cities_requires_authentication(geo_fixture):
    resp = APIClient().get("/v1/geo/cities")
    assert resp.status_code == 401


def test_cities_without_any_filter(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"limit": 50})
    assert resp.status_code == 200
    assert resp.data["next_cursor"] is None
    assert len(resp.data["items"]) == 15  # столько валидных городов в фикстуре


def test_cities_default_limit_is_20(geo_fixture):
    resp = _client().get("/v1/geo/cities")
    assert resp.status_code == 200
    assert len(resp.data["items"]) <= selectors.CITY_LIMIT_DEFAULT


def test_cities_filter_by_country_and_region(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"country": "KZ"})
    assert resp.status_code == 200
    assert {row["name"] for row in resp.data["items"]} == {"Almaty", "Astana"}

    resp = _client().get("/v1/geo/cities", {"region": "KZ-02"})
    assert resp.status_code == 200
    assert {row["name"] for row in resp.data["items"]} == {"Almaty"}
    assert resp.data["items"][0]["region"] == "KZ-02"


def test_cities_filter_by_q(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"q": "almat"})
    assert resp.status_code == 200
    assert {row["name"] for row in resp.data["items"]} == {"Almaty"}


def test_cities_sorted_by_population_desc(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"limit": 50})
    populations = [row["population"] for row in resp.data["items"]]
    assert populations == sorted(populations, reverse=True)


def test_cities_pagination_next_cursor(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"limit": 2})
    assert resp.status_code == 200
    assert len(resp.data["items"]) == 2
    assert resp.data["next_cursor"] is not None

    resp2 = _client().get("/v1/geo/cities", {"limit": 2, "cursor": resp.data["next_cursor"]})
    assert resp2.status_code == 200
    first_ids = {row["id"] for row in resp.data["items"]}
    second_ids = {row["id"] for row in resp2.data["items"]}
    assert first_ids.isdisjoint(second_ids)


def test_cities_limit_over_max_is_400(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"limit": selectors.CITY_LIMIT_MAX + 1})
    assert resp.status_code == 400


def test_cities_limit_zero_is_400(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"limit": 0})
    assert resp.status_code == 400


def test_cities_limit_not_a_number_is_400(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"limit": "abc"})
    assert resp.status_code == 400


def test_cities_invalid_country_is_400(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"country": "kaz"})
    assert resp.status_code == 400


def test_cities_invalid_region_is_400(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"region": "not-a-code"})
    assert resp.status_code == 400


def test_cities_invalid_cursor_is_400(geo_fixture):
    resp = _client().get("/v1/geo/cities", {"cursor": "!!!"})
    assert resp.status_code == 400


def test_regions_limit_over_max_is_400(geo_fixture):
    resp = _client().get("/v1/geo/regions", {"limit": selectors.REGION_LIMIT_MAX + 1})
    assert resp.status_code == 400


# --- display_name на языке зрителя (alternatenames_sample.txt) — план 11.09 §2b, ADR-181 ---


def test_cities_display_name_on_ru_locale(geo_fixture_with_names):
    resp = _client().get("/v1/geo/cities", {"q": "almat"}, HTTP_ACCEPT_LANGUAGE="ru")
    assert resp.status_code == 200
    assert [row["display_name"] for row in resp.data["items"]] == ["Алматы"]


def test_cities_display_name_on_en_locale(geo_fixture_with_names):
    resp = _client().get("/v1/geo/cities", {"q": "almat"}, HTTP_ACCEPT_LANGUAGE="en")
    assert resp.status_code == 200
    assert [row["display_name"] for row in resp.data["items"]] == ["Almaty"]


def test_cities_display_name_never_shows_historic_name(geo_fixture_with_names):
    # "Алма-Ата"/"Alma-Ata" — isHistoric=1 в фикстуре, находятся поиском, но
    # НЕ должны быть тем, что видит зритель.
    resp = _client().get("/v1/geo/cities", {"q": "Алма-Ата"}, HTTP_ACCEPT_LANGUAGE="ru")
    assert resp.status_code == 200
    assert [row["display_name"] for row in resp.data["items"]] == ["Алматы"]


def test_cities_display_name_falls_back_to_name_without_alt_names(geo_fixture_with_names):
    # Zweibrücken — не в alternatenames_sample.txt, name_i18n у неё пустой:
    # фолбэк на исходное name (не name_latin).
    resp = _client().get("/v1/geo/cities", {"q": "zweibrü"}, HTTP_ACCEPT_LANGUAGE="ru")
    assert resp.status_code == 200
    assert [row["display_name"] for row in resp.data["items"]] == ["Zweibrücken"]


def test_regions_display_name_localized(geo_fixture_with_names):
    # "ru"/"en" — встроенная пара (common.i18n.SUPPORTED_LOCALES), доступна
    # без apps.l10n.Locale/пакета; остальные 27 локалей той же логикой
    # проверены на уровне services (test_region_name_i18n_prefers_preferred_
    # name — kk).
    resp = _client().get("/v1/geo/regions", {"country": "KZ"}, HTTP_ACCEPT_LANGUAGE="ru")
    assert resp.status_code == 200
    row = next(r for r in resp.data if r["code"] == "KZ-02")
    assert row["display_name"] == "Алматинская область"


# --- region_name у города (ADR-193): «ввёл город — подставился регион» ---


def test_cities_carry_region_name_on_viewer_locale(geo_fixture_with_names):
    """Фильтр поиска разрешает ввести сразу город и подставляет его регион
    сам — значит строка города обязана показывать название региона НА ЯЗЫКЕ
    ЗРИТЕЛЯ, не латиницей (иначе «Алматы · Almaty Oblysy» в русском UI)."""
    resp = _client().get("/v1/geo/cities", {"q": "almat"}, HTTP_ACCEPT_LANGUAGE="ru")
    assert resp.status_code == 200
    row = resp.data["items"][0]
    assert row["region"] == "KZ-02"
    assert row["region_name"] == "Алматинская область"


def test_cities_region_name_is_null_without_region(geo_fixture):
    """Не у каждой страны источника есть деление первого уровня
    (models.City.region — nullable): тогда подставлять нечего, поле `None`,
    а не пустая строка/падение сериализатора."""
    city = City.objects.filter(region__isnull=True).first()
    assert city is not None, "фикстура обязана содержать город без региона"
    resp = _client().get("/v1/geo/cities", {"q": city.name[:4]})
    assert resp.status_code == 200
    row = next(r for r in resp.data["items"] if r["id"] == city.id)
    assert row["region"] is None
    assert row["region_name"] is None
