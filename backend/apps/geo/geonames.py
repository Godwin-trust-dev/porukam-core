"""Потоковое чтение дампов GeoNames (https://download.geonames.org/export/dump/)
и их скачивание. Чистый ввод-вывод: парсинг конкретных строк в доменные
объекты и запись в БД — в services.py (CLAUDE.md: бизнес-логика не в
management-командах).

Файлы:
- countryInfo.txt — страны (со строками-комментариями `#...` в начале и
  строкой-заголовком `#ISO\t...` последней перед данными — пропускаются все
  строки, начинающиеся с `#`);
- admin1CodesASCII.txt — регионы первого уровня, без заголовка;
- cities15000.zip — архив с ОДНИМ файлом cities15000.txt внутри (населённые
  пункты от 15 000 жителей — порог и обоснование ADR-179);
- alternatenames/<CC>.zip — ПОДУШЕВОЙ файл названий на разных языках (план
  11.09 §2b, ADR-181), архив с `<CC>.txt` (данные) и `readme.txt` (описание
  формата — не строка данных, пропускается по имени); один архив на страну,
  поэтому команда импорта качает/читает их по одному на код страны.

Все читалки — построчные генераторы: ни один файл целиком в память не
грузится (ADR-179 — прод-ВМ с малым объёмом памяти). Для zip это означает
чтение через `ZipFile.open(member)` (распаковка потоком), а не
`ZipFile.read(member)` (которое вернуло бы весь распакованный файл байтовой
строкой)."""

from __future__ import annotations

import io
import shutil
import urllib.request
import zipfile
from collections.abc import Iterator
from pathlib import Path

BASE_URL = "https://download.geonames.org/export/dump"
ALTERNATE_NAMES_BASE_URL = f"{BASE_URL}/alternatenames"
ALTERNATE_NAMES_README = "readme.txt"

COUNTRY_INFO_FILENAME = "countryInfo.txt"
ADMIN1_CODES_FILENAME = "admin1CodesASCII.txt"
CITIES_ZIP_FILENAME = "cities15000.zip"
CITIES_TXT_FILENAME = "cities15000.txt"

_DOWNLOAD_CHUNK_SIZE = 1024 * 256  # 256 КБ — умеренный шаг для потоковой докачки на слабой ВМ.


def _download_to(url: str, target: Path) -> None:
    with urllib.request.urlopen(url) as response, target.open("wb") as out:  # noqa: S310 — источник фиксирован BASE_URL/ALTERNATE_NAMES_BASE_URL
        shutil.copyfileobj(response, out, length=_DOWNLOAD_CHUNK_SIZE)


def download_dump(dest_dir: Path) -> None:
    """Скачивает все три ГЛОБАЛЬНЫХ файла источника в `dest_dir` потоково
    (chunk за chunk на диск через `shutil.copyfileobj`, без буферизации
    целого файла в памяти процесса). Подушевые файлы имён —
    `download_alternate_names` (по одному на страну, отдельно)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    for filename in (COUNTRY_INFO_FILENAME, ADMIN1_CODES_FILENAME, CITIES_ZIP_FILENAME):
        _download_to(f"{BASE_URL}/{filename}", dest_dir / filename)


def alternate_names_zip_filename(country_code: str) -> str:
    return f"{country_code.strip().upper()}.zip"


def download_alternate_names(dest_dir: Path, *, country_code: str) -> Path:
    """Скачивает `<CC>.zip` (подушевой файл имён, план 11.09 §2b) в
    `dest_dir`, возвращает путь к сохранённому архиву. Не у каждого кода
    страны источника есть такой файл (мелкие/спорные территории) — HTTP-404
    здесь не перехватывается, вызывающая сторона (management-команда) решает,
    пропустить ли страну без падения всего импорта."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = alternate_names_zip_filename(country_code)
    target = dest_dir / filename
    _download_to(f"{ALTERNATE_NAMES_BASE_URL}/{filename}", target)
    return target


def iter_country_info(path: Path) -> Iterator[list[str]]:
    """countryInfo.txt → построчно списки полей (без строк-комментариев `#...`)."""
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n").rstrip("\r")
            if not line or line.startswith("#"):
                continue
            yield line.split("\t")


def iter_admin1_codes(path: Path) -> Iterator[list[str]]:
    """admin1CodesASCII.txt → построчно списки полей (заголовка нет)."""
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n").rstrip("\r")
            if not line:
                continue
            yield line.split("\t")


def iter_cities(path: Path) -> Iterator[list[str]]:
    """cities15000.zip ИЛИ уже распакованный cities15000.txt → построчно
    списки полей. Для zip — `ZipFile.open()` даёт файлоподобный поток
    распаковки, `io.TextIOWrapper` поверх него читает построчно без
    промежуточного `.read()` всего содержимого."""
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            member = _find_cities_member(archive)
            with archive.open(member) as raw, io.TextIOWrapper(raw, encoding="utf-8") as fh:
                yield from _split_lines(fh)
    else:
        with path.open(encoding="utf-8") as fh:
            yield from _split_lines(fh)


def iter_alternate_names(path: Path, *, country_code: str | None = None) -> Iterator[list[str]]:
    """`<CC>.zip` (подушевой файл имён) ИЛИ уже распакованный `<CC>.txt` →
    построчно списки полей (10 колонок: alternateNameId, geonameid,
    isolanguage, alternate name, isPreferred, isShort, isColloquial,
    isHistoric, from, to — план 11.09 §2b). В архиве, кроме `<CC>.txt`,
    всегда лежит `readme.txt` (описание формата, не данные) —
    `country_code`, если известен, называет искомого члена архива точно
    (`{country_code}.txt`); без него — любой `.txt`, кроме `readme.txt`."""
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            member = _find_alternate_names_member(archive, country_code)
            with archive.open(member) as raw, io.TextIOWrapper(raw, encoding="utf-8") as fh:
                yield from _split_lines(fh)
    else:
        with path.open(encoding="utf-8") as fh:
            yield from _split_lines(fh)


def _find_alternate_names_member(archive: zipfile.ZipFile, country_code: str | None) -> str:
    if country_code:
        target = f"{country_code.strip().upper()}.txt"
        for name in archive.namelist():
            if name == target:
                return name
    for name in archive.namelist():
        if name.endswith(".txt") and name.lower() != ALTERNATE_NAMES_README:
            return name
    raise FileNotFoundError(f"В архиве {archive.filename} нет файла с альтернативными именами")


def _split_lines(fh: io.TextIOBase) -> Iterator[list[str]]:
    for line in fh:
        line = line.rstrip("\n").rstrip("\r")
        if not line:
            continue
        yield line.split("\t")


def _find_cities_member(archive: zipfile.ZipFile) -> str:
    for name in archive.namelist():
        if name.endswith(".txt"):
            return name
    raise FileNotFoundError(f"В архиве {archive.filename} нет .txt-файла с городами")
