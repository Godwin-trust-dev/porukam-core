"""Потоковые читалки apps.geo.geonames — без БД."""

from __future__ import annotations

import zipfile
from pathlib import Path

from apps.geo import geonames

DATA_DIR = Path(__file__).resolve().parent / "data"


def test_iter_country_info_skips_comments_and_splits_tabs():
    rows = list(geonames.iter_country_info(DATA_DIR / "countryInfo_sample.txt"))
    codes = [row[0] for row in rows]
    assert "RU" in codes
    assert "KZ" in codes
    # Ни одна строка-комментарий (#...) не попала в результат.
    assert all(not row[0].startswith("#") for row in rows)


def test_iter_admin1_codes_splits_tabs():
    rows = list(geonames.iter_admin1_codes(DATA_DIR / "admin1CodesASCII_sample.txt"))
    codes = [row[0] for row in rows]
    assert "KZ.02" in codes
    assert len(rows[0]) == 4


def test_iter_cities_reads_plain_txt():
    rows = list(geonames.iter_cities(DATA_DIR / "cities15000_sample.txt"))
    names = [row[1] for row in rows]
    assert "Almaty" in names
    assert len(rows[0]) == 19


def test_iter_cities_reads_from_zip(tmp_path):
    """Основной формат источника — cities15000.zip: `iter_cities` обязан
    уметь читать член архива потоково (см. модуль geonames.py — почему это
    важно на боевой ВМ с малым объёмом памяти)."""
    zip_path = tmp_path / "cities15000.zip"
    source = (DATA_DIR / "cities15000_sample.txt").read_text(encoding="utf-8")
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr("cities15000.txt", source)

    rows = list(geonames.iter_cities(zip_path))
    names = [row[1] for row in rows]
    assert "Almaty" in names
    assert "Tirana" in names
