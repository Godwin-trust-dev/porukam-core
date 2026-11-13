"""selectors.py apps.geo — поиск на любом уровне, регистронезависимо,
пагинация (план 11.09 §4)."""

from __future__ import annotations

import pytest

from apps.geo import selectors
from apps.geo.models import City

pytestmark = pytest.mark.django_db


def test_list_countries_returns_all_active(geo_fixture):
    codes = {c.code for c in selectors.list_countries()}
    assert codes == {"AL", "BY", "DE", "KZ", "RU", "US"}


def test_list_countries_excludes_inactive(geo_fixture):
    from apps.geo.models import Country

    Country.objects.filter(code="US").update(is_active=False)
    codes = {c.code for c in selectors.list_countries()}
    assert "US" not in codes


def test_format_and_parse_region_code_roundtrip(geo_fixture):
    region = selectors.search_regions(country="KZ", q=None, limit=10)[0]
    composite = selectors.format_region_code(region)
    assert composite == f"KZ-{region.code}"
    assert selectors.parse_region_code(composite) == ("KZ", region.code)


def test_parse_region_code_rejects_bad_format():
    with pytest.raises(selectors.InvalidRegionCodeError):
        selectors.parse_region_code("KZ")
    with pytest.raises(selectors.InvalidRegionCodeError):
        selectors.parse_region_code("KZ_02")
    with pytest.raises(selectors.InvalidRegionCodeError):
        selectors.parse_region_code("KZ-")


def test_search_regions_by_country(geo_fixture):
    regions = selectors.search_regions(country="KZ", q=None, limit=10)
    assert {r.code for r in regions} == {"02", "05"}


def test_search_regions_prefix_matches_original_name(geo_fixture):
    # AL.41 "Dibër County" / "Diber County" — оригинал с диакритикой.
    regions = selectors.search_regions(country=None, q="dibë", limit=10)
    assert [r.code for r in regions] == ["41"]


def test_search_regions_prefix_matches_latin_name(geo_fixture):
    regions = selectors.search_regions(country=None, q="diber", limit=10)
    assert [r.code for r in regions] == ["41"]


def test_search_regions_prefix_is_case_insensitive_with_diacritics(geo_fixture):
    regions = selectors.search_regions(country=None, q="DIBË", limit=10)
    assert [r.code for r in regions] == ["41"]


def test_search_regions_without_filters_returns_all_active(geo_fixture):
    # 16 строк admin1CodesASCII_sample.txt минус 2 (ZZ.01 битая, ZZ.02 —
    # страна не импортирована) = 14 реальных регионов.
    regions = selectors.search_regions(country=None, q=None, limit=100)
    assert len(regions) == 14


def test_search_cities_by_country_only(geo_fixture):
    page = selectors.list_cities(country="KZ", region=None, q=None, limit=10)
    names = {c.name for c in page["items"]}
    assert names == {"Almaty", "Astana"}


def test_search_cities_by_region_composite_code(geo_fixture):
    almaty_region = selectors.search_regions(country="KZ", q="alma", limit=1)[0]
    composite = selectors.format_region_code(almaty_region)
    page = selectors.list_cities(country=None, region=composite, q=None, limit=10)
    names = {c.name for c in page["items"]}
    assert names == {"Almaty"}


def test_search_cities_region_wins_over_conflicting_country(geo_fixture):
    almaty_region = selectors.search_regions(country="KZ", q="alma", limit=1)[0]
    composite = selectors.format_region_code(almaty_region)
    # country="US" явно противоречит region="KZ-...", region главнее.
    page = selectors.list_cities(country="US", region=composite, q=None, limit=10)
    names = {c.name for c in page["items"]}
    assert names == {"Almaty"}


def test_search_cities_prefix_matches_original_and_latin(geo_fixture):
    page_original = selectors.list_cities(country=None, region=None, q="zweibrü", limit=10)
    page_latin = selectors.list_cities(country=None, region=None, q="zweibrue", limit=10)
    assert {c.name for c in page_original["items"]} == {"Zweibrücken"}
    assert {c.name for c in page_latin["items"]} == {"Zweibrücken"}


def test_search_cities_prefix_is_case_insensitive_with_diacritics(geo_fixture):
    page = selectors.list_cities(country=None, region=None, q="ZWEIBRÜ", limit=10)
    assert {c.name for c in page["items"]} == {"Zweibrücken"}


def test_search_cities_without_filters_returns_everything(geo_fixture):
    page = selectors.list_cities(country=None, region=None, q=None, limit=100)
    assert len(page["items"]) == City.objects.count()


def test_search_cities_sorted_by_population_desc(geo_fixture):
    page = selectors.list_cities(country=None, region=None, q=None, limit=100)
    populations = [c.population for c in page["items"]]
    assert populations == sorted(populations, reverse=True)


def test_city_pagination_walks_all_rows_without_duplicates(geo_fixture):
    total = City.objects.count()
    seen: list[int] = []
    cursor = None
    for _ in range(total + 1):  # с запасом — не должно понадобиться
        page = selectors.list_cities(country=None, region=None, q=None, limit=2, cursor=cursor)
        seen.extend(c.id for c in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(seen) == total
    assert len(set(seen)) == total  # без дублей


def test_invalid_city_cursor_raises():
    with pytest.raises(selectors.InvalidCityCursorError):
        selectors.list_cities(
            country=None, region=None, q=None, limit=10, cursor="!!!not-base64!!!"
        )


# --- поиск на любом из наших языков (alternatenames_sample.txt) — план 11.09 §2b, ADR-181 ---


def test_search_cities_by_cyrillic_alt_name(geo_fixture_with_names):
    page = selectors.list_cities(country=None, region=None, q="Моск", limit=10)
    assert {c.name for c in page["items"]} == {"Moscow"}


def test_search_cities_by_historic_alt_name(geo_fixture_with_names):
    # "Алма-Ата" (isHistoric=1 в фикстуре) обязана находить Almaty.
    page = selectors.list_cities(country=None, region=None, q="Алма-Ата", limit=10)
    assert {c.name for c in page["items"]} == {"Almaty"}


def test_search_cities_by_latin_alt_name_still_works(geo_fixture_with_names):
    # "Almat" совпадает и с исходным name/name_latin (уже покрыто другим
    # тестом), и с CityName en "Almaty" — не должно давать дублей.
    page = selectors.list_cities(country=None, region=None, q="Almat", limit=10)
    assert [c.name for c in page["items"]] == ["Almaty"]


def test_search_cities_by_alt_name_no_duplicates_across_locales(geo_fixture_with_names):
    # kk и ru preferred-имена Алматы совпадают буквально ("Алматы") —
    # семи-join (pk__in=Subquery) не должен размножить строку City.
    page = selectors.list_cities(country=None, region=None, q="Алматы", limit=10)
    assert [c.name for c in page["items"]] == ["Almaty"]


def test_search_cities_by_alt_name_respects_country_filter(geo_fixture_with_names):
    # "Алматы" находит город Almaty только через CityName (KZ) — с
    # country="US" среди городов не должно найтись ничего.
    page = selectors.list_cities(country="US", region=None, q="Алматы", limit=10)
    assert page["items"] == []


def test_search_cities_unsupported_language_row_not_searchable(geo_fixture_with_names):
    page = selectors.list_cities(country=None, region=None, q="Almato", limit=10)
    assert page["items"] == []


def test_search_regions_by_alt_name(geo_fixture_with_names):
    regions = selectors.search_regions(country=None, q="Алматинская", limit=10)
    assert [r.code for r in regions] == ["02"]


def test_search_regions_by_alt_name_kk(geo_fixture_with_names):
    regions = selectors.search_regions(country=None, q="Алматы облысы", limit=10)
    assert [r.code for r in regions] == ["02"]


def test_search_cities_pagination_unaffected_by_alt_names(geo_fixture_with_names):
    # Та же проверка "без дублей на всех страницах", что и без имён —
    # семи-join по CityName не должен ломать keyset-пагинацию.
    total = City.objects.count()
    seen: list[int] = []
    cursor = None
    for _ in range(total + 1):
        page = selectors.list_cities(country=None, region=None, q=None, limit=2, cursor=cursor)
        seen.extend(c.id for c in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(seen) == total
    assert len(set(seen)) == total
