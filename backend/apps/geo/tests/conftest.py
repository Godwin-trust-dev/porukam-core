from __future__ import annotations

from pathlib import Path

import pytest

from apps.geo import geonames, services

DATA_DIR = Path(__file__).resolve().parent / "data"

# Полный набор стран фикстуры (apps/geo/tests/data/*_sample.txt) —
# countryInfo_sample.txt содержит ровно эти 6 + одну битую строку (XYZ).
FIXTURE_COUNTRIES = frozenset({"AL", "BY", "DE", "KZ", "RU", "US"})


def import_fixture(
    *, countries: frozenset[str] | None = FIXTURE_COUNTRIES, with_names: bool = False
) -> services.ImportStats:
    """Прогон services.import_geo_dataset на маленькой фикстуре из
    apps/geo/tests/data — та же функция, что вызывает manage.py import_geo,
    только источники читаются с диска напрямую (без download/zip).

    `with_names=False` (по умолчанию) — БЕЗ подушевых имён (сохраняет
    прежнее поведение `geo_fixture`: `test_name_i18n_defaults_to_empty_dict`
    проверяет, что без этого шага `name_i18n` остаётся пустым).
    `with_names=True` — план 11.09 §2b (ADR-181): добавляет
    `alternatenames_sample.txt` (Алматы/Москва/Алматинская область на
    kk/ru/en + строки-ловушки — неизвестный geonameid, чужой язык, битый
    alternateNameId)."""
    alt_name_rows = (
        geonames.iter_alternate_names(DATA_DIR / "alternatenames_sample.txt")
        if with_names
        else None
    )
    return services.import_geo_dataset(
        country_rows=geonames.iter_country_info(DATA_DIR / "countryInfo_sample.txt"),
        admin1_rows=geonames.iter_admin1_codes(DATA_DIR / "admin1CodesASCII_sample.txt"),
        city_rows=geonames.iter_cities(DATA_DIR / "cities15000_sample.txt"),
        countries=countries,
        alt_name_rows=alt_name_rows,
    )


@pytest.fixture
def geo_fixture(db) -> services.ImportStats:
    """Импортирует фикстуру целиком (6 стран), БЕЗ подушевых имён."""
    return import_fixture()


@pytest.fixture
def geo_fixture_with_names(db) -> services.ImportStats:
    """Импортирует фикстуру целиком (6 стран) + подушевые имена
    (alternatenames_sample.txt) — план 11.09 §2b."""
    return import_fixture(with_names=True)
