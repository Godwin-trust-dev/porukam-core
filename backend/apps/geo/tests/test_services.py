"""Импорт справочника из фикстуры (apps/geo/tests/data) — план 11.09 §3,
подушевые имена — §2b (ADR-181)."""

from __future__ import annotations

import pytest

from apps.geo.models import City, CityName, Country, Region, RegionName

from .conftest import import_fixture

pytestmark = pytest.mark.django_db


def test_import_creates_countries_regions_cities(geo_fixture):
    assert set(Country.objects.values_list("code", flat=True)) == {
        "AL",
        "BY",
        "DE",
        "KZ",
        "RU",
        "US",
    }
    assert Region.objects.filter(country_id="KZ", code="02").exists()
    assert City.objects.filter(name="Almaty").exists()
    # Битые строки посчитаны, но не создали записей: XYZ (countryInfo,
    # невалидный код), ZZ.01 (admin1, geonames_id не число), Nowhereville
    # (city, population не число) — итого 3. Строки страны ZZ (ZZ.02,
    # Zetaville) в этот прогон НЕ попадают вовсе: geo_fixture по умолчанию
    # импортирует только страны фикстуры (conftest.FIXTURE_COUNTRIES),
    # поэтому они отсеиваются обычным фильтром countries=, а не «защитой от
    # неизвестной страны» (see test_import_without_country_filter_counts_
    # unknown_country_rows_as_skipped — там ZZ дойдёт до этой защиты).
    assert geo_fixture.skipped_rows == 3
    assert not Country.objects.filter(code="XYZ").exists()
    assert not Country.objects.filter(code="ZZ").exists()


def test_import_without_country_filter_counts_unknown_country_rows_as_skipped(db):
    # countries=None — «тянуть все страны источника»: XYZ (countryInfo)
    # всё равно отсеивается (невалидный код), а вот ZZ.02/Zetaville теперь
    # доходят до проверки «страна не импортирована» (Country.ZZ никогда не
    # создаётся — XYZ не прошёл валидацию кода) и тоже считаются пропуском.
    stats = import_fixture(countries=None)
    assert stats.regions == 14
    assert stats.cities == 15
    assert stats.skipped_rows == 5
    assert not Region.objects.filter(code="02", name="Zeta Province").exists()
    assert not City.objects.filter(name="Zetaville").exists()


def test_import_country_filter_limits_dataset(db):
    stats = import_fixture(countries=frozenset({"KZ", "RU"}))
    assert set(Country.objects.values_list("code", flat=True)) == {"KZ", "RU"}
    assert stats.countries == 2
    assert not City.objects.filter(country_id="US").exists()
    assert not Region.objects.filter(country_id="DE").exists()


def test_import_is_idempotent(geo_fixture):
    before_countries = Country.objects.count()
    before_regions = Region.objects.count()
    before_cities = City.objects.count()

    import_fixture()

    assert Country.objects.count() == before_countries
    assert Region.objects.count() == before_regions
    assert City.objects.count() == before_cities


def test_reimport_updates_existing_row_instead_of_duplicating(geo_fixture):
    almaty = City.objects.get(name="Almaty")
    almaty.population = 1
    almaty.save(update_fields=["population"])

    import_fixture()

    almaty.refresh_from_db()
    assert almaty.population == 1_977_011
    assert City.objects.filter(geonames_id=almaty.geonames_id).count() == 1


def test_malformed_admin1_row_does_not_break_import(geo_fixture):
    # ZZ.01 — geonames_id "NOTANUMBER": строка пропущена, а не свалила батч.
    assert not Region.objects.filter(code="01", name="Nowhere Region").exists()
    assert Region.objects.filter(country_id="KZ").exists()


def test_admin1_row_of_unknown_country_is_skipped(geo_fixture):
    # ZZ.02 — валидная строка, но страны ZZ нет среди импортированных.
    assert not Region.objects.filter(code="02", name="Zeta Province").exists()


def test_malformed_city_row_does_not_break_import(geo_fixture):
    # Nowhereville — population "NOTANUMBER".
    assert not City.objects.filter(name="Nowhereville").exists()
    assert City.objects.filter(name="Almaty").exists()


def test_city_row_of_unknown_country_is_skipped(geo_fixture):
    # Zetaville — валидная строка, страна ZZ не импортирована.
    assert not City.objects.filter(name="Zetaville").exists()


def test_city_links_to_region_by_admin1_code(geo_fixture):
    almaty = City.objects.get(name="Almaty")
    assert almaty.region is not None
    assert almaty.region.country_id == "KZ"
    assert almaty.region.code == "02"


def test_city_without_matching_region_row_has_null_region(geo_fixture):
    # Sasovo — admin1 "62" (Рязанская область), в фикстуре admin1 нет — не
    # ошибка импорта, а честное отсутствие региона в справочнике.
    sasovo = City.objects.get(name="Sasovo")
    assert sasovo.region is None
    assert sasovo.country_id == "RU"


def test_city_name_and_name_latin_differ_when_source_gives_diacritics(geo_fixture):
    city = City.objects.get(geonames_id=2803620)  # Zweibrücken
    assert city.name == "Zweibrücken"
    assert city.name_latin == "Zweibruecken"


def test_name_i18n_defaults_to_empty_dict(geo_fixture):
    city = City.objects.get(name="Almaty")
    assert city.name_i18n == {}
    region = Region.objects.get(country_id="KZ", code="02")
    assert region.name_i18n == {}


# --- подушевые имена (alternatenames_sample.txt) — план 11.09 §2b, ADR-181 ---


def test_names_import_creates_city_name_rows(geo_fixture_with_names):
    almaty = City.objects.get(name="Almaty")
    locales = set(CityName.objects.filter(city=almaty).values_list("locale", flat=True))
    # kk preferred, ru preferred + ru historic, en preferred + en historic —
    # эсперанто ("eo") и битая строка (alternateNameId="badid") не попали.
    assert locales == {"kk", "ru", "en"}
    assert CityName.objects.filter(city=almaty).count() == 5


def test_names_import_creates_region_name_rows(geo_fixture_with_names):
    region = Region.objects.get(country_id="KZ", code="02")
    assert set(RegionName.objects.filter(region=region).values_list("locale", flat=True)) == {
        "ru",
        "kk",
    }


def test_names_import_skips_unknown_geonameid(geo_fixture_with_names):
    assert not CityName.objects.filter(name="Нигдевск").exists()


def test_names_import_skips_unsupported_language(geo_fixture_with_names):
    assert not CityName.objects.filter(name="Almato").exists()


def test_names_import_skips_malformed_alternate_name_id(geo_fixture_with_names):
    assert not CityName.objects.filter(name="Плохая строка").exists()


def test_names_import_counts_skipped_and_written(geo_fixture_with_names):
    # 5 (Алматы) + 3 (Москва) = 8 имён городов; 2 имени региона (KZ.02);
    # 3 строки-ловушки имён (неизвестный id, чужой язык, битый id) + 3 битых
    # строки базовой фикстуры (test_import_creates_countries_regions_cities)
    # = 6 пропущенных всего.
    assert geo_fixture_with_names.city_names == 8
    assert geo_fixture_with_names.region_names == 2
    assert geo_fixture_with_names.skipped_rows == 6


def test_names_import_is_idempotent(geo_fixture_with_names):
    before_city_names = CityName.objects.count()
    before_region_names = RegionName.objects.count()

    import_fixture(with_names=True)

    assert CityName.objects.count() == before_city_names
    assert RegionName.objects.count() == before_region_names


def test_reimport_names_updates_existing_row_instead_of_duplicating(geo_fixture_with_names):
    row = CityName.objects.get(geonames_alt_name_id=1984265)  # ru historic Алма-Ата
    row.name = "temp"
    row.save(update_fields=["name"])

    import_fixture(with_names=True)

    row.refresh_from_db()
    assert row.name == "Алма-Ата"
    assert CityName.objects.filter(geonames_alt_name_id=1984265).count() == 1


def test_name_i18n_prefers_preferred_name(geo_fixture_with_names):
    almaty = City.objects.get(name="Almaty")
    # Текущее предпочитаемое ru-имя — "Алматы" (isPreferred=1, id 11663941),
    # НЕ историческое "Алма-Ата" (isHistoric=1, id 1984265) — несмотря на
    # то, что оно тоже в базе (участвует в поиске, не в отображении).
    assert almaty.name_i18n["ru"] == "Алматы"
    assert almaty.name_i18n["en"] == "Almaty"
    assert almaty.name_i18n["kk"] == "Алматы"


def test_name_i18n_never_shows_historic_name(geo_fixture_with_names):
    almaty = City.objects.get(name="Almaty")
    assert "Алма-Ата" not in almaty.name_i18n.values()
    assert "Alma-Ata" not in almaty.name_i18n.values()


def test_name_i18n_falls_back_to_any_non_historic_when_no_preferred(geo_fixture_with_names):
    moscow = City.objects.get(name="Moscow")
    # kk-имя Москвы в фикстуре — без isPreferred, но единственное непустое
    # непредпочитаемое ru/en-имя: "любое имя локали", когда preferred нет.
    assert moscow.name_i18n["kk"] == "Мәскеу"


def test_name_i18n_absent_for_locale_without_any_row(geo_fixture_with_names):
    almaty = City.objects.get(name="Almaty")
    assert "fr" not in almaty.name_i18n


def test_region_name_i18n_prefers_preferred_name(geo_fixture_with_names):
    region = Region.objects.get(country_id="KZ", code="02")
    assert region.name_i18n["ru"] == "Алматинская область"
    assert region.name_i18n["kk"] == "Алматы облысы"


def test_import_without_alt_name_rows_leaves_city_name_table_empty(geo_fixture):
    # geo_fixture (без with_names) не должен создавать ни одной строки
    # CityName/RegionName — таблицы имён существуют, но не населяются, пока
    # alt_name_rows не передан явно (--skip-names в команде).
    assert not CityName.objects.exists()
    assert not RegionName.objects.exists()
