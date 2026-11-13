"""Выбор отображаемого имени (`name_i18n`) — ADR-183: флаги `is_colloquial`/
`is_short`, фолбэк-иерархия, тай-брейк по родной письменности локали.

Прямые тесты уровня services (без файлов-фикстур apps/geo/tests/data —
конкретные numbers/строки этой ветки не хотят делить общий датасет с
test_services.py/ADR-181): City/Region создаются через ORM, строки
alternatenames — как список полей (тот же формат, что даёт
`apps.geo.geonames.iter_alternate_names`), напрямую в `services.
import_alternate_names` + `refresh_city_name_i18n`/`refresh_region_name_i18n`."""

from __future__ import annotations

import pytest

from apps.geo import selectors, services
from apps.geo.models import City, Country, Region

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
    historic: bool = False,
) -> list[str]:
    """Строка alternatenames — колонки: alternateNameId, geonameid,
    isolanguage, name, isPreferred, isShort, isColloquial, isHistoric."""
    return [
        str(alt_id),
        str(geonameid),
        lang,
        name,
        "1" if preferred else "",
        "1" if short else "",
        "1" if colloquial else "",
        "1" if historic else "",
    ]


@pytest.fixture
def ru() -> Country:
    return Country.objects.create(code="RU")


@pytest.fixture
def city(ru: Country) -> City:
    return City.objects.create(country=ru, name="Test City", name_latin="Test City", geonames_id=1)


@pytest.fixture
def region(ru: Country) -> Region:
    return Region.objects.create(
        country=ru, code="99", name="Test Region", name_latin="Test Region", geonames_id=2
    )


def _import_city_rows(rows: list[list[str]], city_obj: City) -> None:
    services.import_alternate_names(
        rows,
        city_id_by_geonames_id={city_obj.geonames_id: city_obj.id},
        region_id_by_geonames_id={},
    )
    services.refresh_city_name_i18n([city_obj.id])
    city_obj.refresh_from_db()


def _import_region_rows(rows: list[list[str]], region_obj: Region) -> None:
    assert region_obj.geonames_id is not None
    services.import_alternate_names(
        rows,
        city_id_by_geonames_id={},
        region_id_by_geonames_id={region_obj.geonames_id: region_obj.id},
    )
    services.refresh_region_name_i18n([region_obj.id])
    region_obj.refresh_from_db()


# --- is_colloquial/is_short: разбор из источника (колонки 5/6) ---


def test_import_parses_is_short_and_is_colloquial_flags(city):
    _import_city_rows(
        [
            _row(1, city.geonames_id, "ru", "Короткое", short=True),
            _row(2, city.geonames_id, "ru", "Разговорное", colloquial=True),
            _row(3, city.geonames_id, "ru", "Обычное"),
        ],
        city,
    )
    names = {n.name: n for n in city.alt_names.filter(locale="ru")}
    assert names["Короткое"].is_short is True
    assert names["Короткое"].is_colloquial is False
    assert names["Разговорное"].is_colloquial is True
    assert names["Разговорное"].is_short is False
    assert names["Обычное"].is_short is False
    assert names["Обычное"].is_colloquial is False


# --- Дефект 1 (регион): isShort ИЛИ isColloquial — оба исключаются из отображения ---


def test_region_short_preferred_name_excluded_from_display_ставрополье(region):
    # Воспроизводит факт со Ставропольским краем: разговорное имя помечено
    # ИМЕННО isShort (не isColloquial) и при этом isPreferred=1 — старое
    # правило "-is_preferred, id" выбирало бы его безоговорочно.
    _import_region_rows(
        [
            _row(1, region.geonames_id, "ru", "Ставрополье", preferred=True, short=True),
            _row(2, region.geonames_id, "ru", "Ставропольский Край"),
        ],
        region,
    )
    # "Край" нормализуется в строчную (ADR-183, доп. 12.09 —
    # normalize_generic_terms) — см. отдельные тесты нормализации ниже.
    assert region.name_i18n["ru"] == "Ставропольский край"


def test_region_colloquial_preferred_name_excluded_from_display(region):
    _import_region_rows(
        [
            _row(1, region.geonames_id, "ru", "Коротко", preferred=True, colloquial=True),
            _row(2, region.geonames_id, "ru", "Полное Имя"),
        ],
        region,
    )
    assert region.name_i18n["ru"] == "Полное Имя"


def test_colloquial_and_short_names_still_found_by_search(region):
    # Поиск — apps.geo.selectors — НЕ фильтрует is_colloquial/is_short (как
    # и is_historic, ADR-181): «Ставрополье» обязано находить регион, даже
    # если он не отображается под этим именем.
    _import_region_rows(
        [
            _row(1, region.geonames_id, "ru", "Ставрополье", preferred=True, short=True),
            _row(2, region.geonames_id, "ru", "Ставропольский Край"),
        ],
        region,
    )
    found = selectors.search_regions(country="RU", q="ставрополье")
    assert region in found


def test_historic_name_still_found_by_search_but_never_displayed(city):
    _import_city_rows(
        [
            _row(1, city.geonames_id, "ru", "Старое Имя", preferred=True, historic=True),
            _row(2, city.geonames_id, "ru", "Новое Имя"),
        ],
        city,
    )
    assert city.name_i18n["ru"] == "Новое Имя"
    found = selectors.list_cities(country="RU", region=None, q="старое")
    assert city in found["items"]


# --- Preferred побеждает среди ПОЛНОЙ формы ---


def test_preferred_wins_among_full_form_candidates(city):
    _import_city_rows(
        [
            _row(1, city.geonames_id, "ru", "Не предпочитаемое"),
            _row(2, city.geonames_id, "ru", "Предпочитаемое", preferred=True),
        ],
        city,
    )
    assert city.name_i18n["ru"] == "Предпочитаемое"


# --- Дефект 2 (город): тай-брейк по родной письменности локали ---


def test_native_script_tiebreak_prefers_cyrillic_over_latin_transliteration(city):
    # Воспроизводит факт со Ставрополем: обе строки isPreferred=0, латинская
    # транслитерация ("Stavropol’", апостроф U+2019 — уже НЕ ASCII) получает
    # МЕНЬШИЙ alternateNameId — старый тай-брейк по id выбрал бы её.
    _import_city_rows(
        [
            _row(1, city.geonames_id, "ru", "Stavropol’"),
            _row(2, city.geonames_id, "ru", "Ставрополь"),
        ],
        city,
    )
    assert city.name_i18n["ru"] == "Ставрополь"


def test_native_script_tiebreak_order_independent_of_id(city):
    # То же самое, но кириллица теперь ПЕРВАЯ (меньший id) — результат не
    # должен зависеть от порядка вставки (латиница не должна побеждать
    # никогда, если есть кириллический кандидат той же приоритетности).
    _import_city_rows(
        [
            _row(1, city.geonames_id, "ru", "Ставрополь"),
            _row(2, city.geonames_id, "ru", "Stavropol’"),
        ],
        city,
    )
    assert city.name_i18n["ru"] == "Ставрополь"


def test_native_script_tiebreak_not_applied_to_latin_script_locale(city):
    # "en" не входит в constants.LOCALE_SCRIPT_RANGES — тай-брейк не
    # применяется, поведение как до ADR-183 (id по возрастанию).
    _import_city_rows(
        [
            _row(1, city.geonames_id, "en", "First"),
            _row(2, city.geonames_id, "en", "Second"),
        ],
        city,
    )
    assert city.name_i18n["en"] == "First"


# --- Фолбэк на короткое/разговорное имя, когда полной формы нет вовсе ---


def test_colloquial_fallback_used_when_no_full_form_candidate_exists_мурманск(city):
    # Воспроизводит факт с Мурманском: источник метит ДЕЙСТВУЮЩЕЕ имя
    # is_short=1, is_colloquial=1 — полной формы для этой локали нет вовсе,
    # только исторические и явные прозвища. Абсолютное исключение оставило
    # бы город без ru-имени (латинский фолбэк хуже) — фолбэк-иерархия
    # должна показать «Мурманск», а не пропустить локаль вовсе.
    _import_city_rows(
        [
            _row(
                1, city.geonames_id, "ru", "Мурманск", preferred=True, short=True, colloquial=True
            ),
            _row(2, city.geonames_id, "ru", "Романов-на-Мурмане", historic=True),
            _row(3, city.geonames_id, "ru", "столица Заполярья", colloquial=True),
        ],
        city,
    )
    assert city.name_i18n["ru"] == "Мурманск"


def test_full_form_candidate_wins_over_fallback_when_both_exist(city):
    # Полная форма ЕСТЬ (хоть и не preferred) — фолбэк-уровень не должен
    # применяться, полная форма побеждает разговорную/короткую в любом случае.
    _import_city_rows(
        [
            _row(1, city.geonames_id, "ru", "Коротко", preferred=True, short=True),
            _row(2, city.geonames_id, "ru", "Полная Форма"),
        ],
        city,
    )
    assert city.name_i18n["ru"] == "Полная Форма"


def test_historic_name_never_used_even_as_last_resort(city):
    # Единственный кандидат локали — историческое имя: is_historic не имеет
    # фолбэка (в отличие от is_colloquial/is_short) — локаль в name_i18n
    # вообще отсутствует, а не заполняется историческим именем.
    _import_city_rows(
        [_row(1, city.geonames_id, "ru", "Старое Имя", preferred=True, historic=True)],
        city,
    )
    assert "ru" not in city.name_i18n


def test_locale_absent_entirely_when_no_row_at_all(city):
    services.refresh_city_name_i18n([city.id])
    city.refresh_from_db()
    assert city.name_i18n == {}


# --- Регистр родовых слов в названиях регионов (ADR-183, доп. 12.09) ---


def test_region_generic_term_normalized_in_name_i18n_ставрополье_край(region):
    # Воспроизводит факт (доп. владельца 12.09): GeoNames отдаёт "Ставропольский
    # Край" В TITLE CASE — отображение обязано показать "...край" строчными.
    _import_region_rows(
        [_row(1, region.geonames_id, "ru", "Ставропольский Край")],
        region,
    )
    assert region.name_i18n["ru"] == "Ставропольский край"


def test_region_generic_term_normalization_does_not_affect_raw_stored_row(region):
    # Нормализация — ТОЛЬКО в name_i18n (отображение), сырая RegionName.name
    # остаётся КАК ДАЛ ИСТОЧНИК (нужна для поиска — «Ставропольский Край»
    # с большой буквы обязана находиться префиксным поиском тоже).
    _import_region_rows(
        [_row(1, region.geonames_id, "ru", "Ставропольский Край")],
        region,
    )
    row = region.alt_names.get(locale="ru")
    assert row.name == "Ставропольский Край"
    found = selectors.search_regions(country="RU", q="ставропольский край")
    assert region in found


def test_region_republic_word_never_lowercased_first_position(region):
    _import_region_rows(
        [_row(1, region.geonames_id, "ru", "Республика Адыгея")],
        region,
    )
    assert region.name_i18n["ru"] == "Республика Адыгея"


def test_region_republic_word_never_lowercased_second_position(region):
    _import_region_rows(
        [_row(1, region.geonames_id, "ru", "Чеченская Республика")],
        region,
    )
    assert region.name_i18n["ru"] == "Чеченская Республика"


def test_region_generic_term_as_first_word_kept_capitalized(region):
    _import_region_rows(
        [_row(1, region.geonames_id, "ru", "Округ Условный")],
        region,
    )
    assert region.name_i18n["ru"] == "Округ Условный"


def test_region_generic_term_normalization_not_applied_to_other_locale(region):
    _import_region_rows(
        [_row(1, region.geonames_id, "en", "Stavropol Krai")],
        region,
    )
    # "en" не входит в constants.GENERIC_TERM_LOWERCASE — не трогаем вовсе.
    assert region.name_i18n["en"] == "Stavropol Krai"
