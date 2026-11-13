"""Аудит покрытия имён (ADR-183) — `selectors.audit_city_name_coverage`/
`audit_region_name_coverage` и тонкая обёртка `manage.py geo_name_audit`."""

from __future__ import annotations

import io

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.geo import selectors, services
from apps.geo.models import City, Country

pytestmark = pytest.mark.django_db


def _row(
    alt_id: int,
    geonameid: int,
    lang: str,
    name: str,
    *,
    preferred: bool = False,
    short: bool = False,
    colloquial: bool = False,
) -> list[str]:
    return [
        str(alt_id),
        str(geonameid),
        lang,
        name,
        "1" if preferred else "",
        "1" if short else "",
        "1" if colloquial else "",
        "",
    ]


@pytest.fixture
def ru() -> Country:
    return Country.objects.create(code="RU")


@pytest.fixture
def cities(ru: Country) -> dict[str, City]:
    """Три города RU: один без ru-имени вовсе (латиница), один с полной
    формой, один — только с коротким/разговорным (фолбэк-уровень)."""
    latin_only = City.objects.create(
        country=ru, name="Latinsk", name_latin="Latinsk", geonames_id=101
    )
    full_form = City.objects.create(country=ru, name="Fullsk", name_latin="Fullsk", geonames_id=102)
    colloquial_only = City.objects.create(
        country=ru, name="Collsk", name_latin="Collsk", geonames_id=103
    )
    services.import_alternate_names(
        [
            _row(1, 102, "ru", "Полное Имя"),
            _row(2, 103, "ru", "Коротко", preferred=True, short=True),
        ],
        city_id_by_geonames_id={
            full_form.geonames_id: full_form.id,
            colloquial_only.geonames_id: colloquial_only.id,
        },
        region_id_by_geonames_id={},
    )
    services.refresh_city_name_i18n([latin_only.id, full_form.id, colloquial_only.id])
    return {"latin_only": latin_only, "full_form": full_form, "colloquial_only": colloquial_only}


def test_audit_counts_latin_fallback_and_colloquial_shown(cities):
    report = selectors.audit_city_name_coverage(locale="ru", countries=None, limit=50)
    assert report.total == 3
    assert report.latin_fallback_total == 1
    assert report.colloquial_or_short_total == 1
    by_country = {row.country: row for row in report.by_country}
    assert by_country["RU"].total == 3
    assert by_country["RU"].latin_fallback == 1
    assert by_country["RU"].colloquial_or_short == 1
    assert by_country["RU"].full_form == 1


def test_audit_examples_list_the_right_objects(cities):
    report = selectors.audit_city_name_coverage(locale="ru", countries=None, limit=50)
    latin_names = {ex.name_latin for ex in report.latin_examples}
    assert latin_names == {"Latinsk"}
    colloquial = {(ex.name_latin, ex.shown_name) for ex in report.colloquial_examples}
    assert colloquial == {("Collsk", "Коротко")}
    # "Fullsk" (полная форма) не попадает НИ в один из проблемных списков.
    assert "Fullsk" not in latin_names
    assert all(ex.name_latin != "Fullsk" for ex in report.colloquial_examples)


def test_audit_limit_caps_examples(cities):
    report = selectors.audit_city_name_coverage(locale="ru", countries=None, limit=0)
    assert report.latin_examples == []
    assert report.colloquial_examples == []
    # Счётчики не зависят от limit — он режет только список примеров.
    assert report.latin_fallback_total == 1
    assert report.colloquial_or_short_total == 1


def test_audit_countries_filter(cities, ru):
    other = Country.objects.create(code="KZ")
    City.objects.create(country=other, name="Almaty", name_latin="Almaty", geonames_id=999)

    report = selectors.audit_city_name_coverage(locale="ru", countries=frozenset({"KZ"}), limit=50)
    assert report.total == 1
    assert {row.country for row in report.by_country} == {"KZ"}


def test_audit_region_coverage_empty_db_returns_zero_total():
    report = selectors.audit_region_name_coverage(locale="ru", countries=None, limit=50)
    assert report.total == 0
    assert report.by_country == []


def test_audit_matches_colloquial_name_containing_generic_term_despite_normalization(ru):
    # Регрессия ADR-183 (доп. 12.09): name_i18n хранит НОРМАЛИЗОВАННЫЙ текст
    # (constants.normalize_generic_terms), а CityName/RegionName.name —
    # СЫРОЙ. Аудит сравнивает их по значению — если разговорное/короткое имя
    # само содержит родовое слово (Title Case из источника), сравнение
    # обязано нормализовать ОБЕ стороны одинаково, иначе колонка
    # "разговорным/коротким" не найдёт совпадение.
    from apps.geo.models import Region

    region = Region.objects.create(
        country=ru, code="77", name="Test Region", name_latin="Test Region", geonames_id=555
    )
    services.import_alternate_names(
        [
            [
                "1",
                "555",
                "ru",
                "Тестовая Область",  # Title Case, как у источника
                "1",  # isPreferred
                "1",  # isShort — разговорное/короткое, полной формы нет
                "",
                "",
            ]
        ],
        city_id_by_geonames_id={},
        region_id_by_geonames_id={555: region.id},
    )
    services.refresh_region_name_i18n([region.id])
    region.refresh_from_db()
    assert region.name_i18n["ru"] == "Тестовая область"  # нормализовано для отображения

    report = selectors.audit_region_name_coverage(locale="ru", countries=None, limit=50)
    matching = [ex for ex in report.colloquial_examples if ex.name_latin == "Test Region"]
    assert len(matching) == 1
    assert matching[0].shown_name == "Тестовая область"


# --- manage.py geo_name_audit ---


def test_command_prints_regions_before_cities(cities):
    out = io.StringIO()
    call_command("geo_name_audit", locale="ru", stdout=out)
    text = out.getvalue()
    assert text.index("РЕГИОНЫ") < text.index("ГОРОДА")


def test_command_reports_counts_and_examples(cities):
    out = io.StringIO()
    call_command("geo_name_audit", locale="ru", stdout=out)
    text = out.getvalue()
    assert "латиницей: 1" in text
    assert "разговорным/коротким: 1" in text
    assert "Latinsk" in text
    assert "Collsk" in text


def test_command_empty_locale_raises():
    with pytest.raises(CommandError):
        call_command("geo_name_audit", locale="  ")


def test_command_negative_limit_raises():
    with pytest.raises(CommandError):
        call_command("geo_name_audit", locale="ru", limit=-1)


def test_command_countries_filter_parsed(cities):
    out = io.StringIO()
    call_command("geo_name_audit", locale="ru", countries="kz", stdout=out)
    # KZ не существует в этой фикстуре — 0 объектов, но команда не падает.
    assert "Нет данных" in out.getvalue()
