"""manage.py import_geo — CLI-обёртка (аргументы, ошибки, вызов services).

`--dir` ждёт файлы под НАСТОЯЩИМИ именами GeoNames (countryInfo.txt,
admin1CodesASCII.txt, cities15000.zip/.txt — как их и кладёт `wget`/браузер
при ручном скачивании), поэтому фикстуры apps/geo/tests/data (названные
по-другому, чтобы не путать с настоящим дампом) копируются во временный
каталог под нужными именами перед вызовом команды."""

from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.geo.constants import DEFAULT_COUNTRY_CODES
from apps.geo.models import City, CityName, Country, Region

DATA_DIR = Path(__file__).resolve().parent / "data"

pytestmark = pytest.mark.django_db


@pytest.fixture
def source_dir(tmp_path) -> Path:
    """Каталог с файлами под настоящими именами GeoNames — cities15000
    как ZIP (основной сценарий; распакованный .txt проверяет отдельный тест)."""
    shutil.copy(DATA_DIR / "countryInfo_sample.txt", tmp_path / "countryInfo.txt")
    shutil.copy(DATA_DIR / "admin1CodesASCII_sample.txt", tmp_path / "admin1CodesASCII.txt")
    with zipfile.ZipFile(tmp_path / "cities15000.zip", "w") as archive:
        archive.write(DATA_DIR / "cities15000_sample.txt", arcname="cities15000.txt")
    return tmp_path


def test_requires_dir_or_download():
    with pytest.raises(CommandError, match="dir.*download|download.*dir"):
        call_command("import_geo")


def test_dir_and_download_are_mutually_exclusive(source_dir):
    with pytest.raises(CommandError):
        call_command("import_geo", source_dir=str(source_dir), download=True)


def test_missing_dir_raises():
    with pytest.raises(CommandError):
        call_command("import_geo", source_dir="/no/such/directory")


def test_dir_without_required_files_raises(tmp_path):
    with pytest.raises(CommandError):
        call_command("import_geo", source_dir=str(tmp_path))


def test_import_from_dir_with_explicit_countries(source_dir):
    out = io.StringIO()
    call_command("import_geo", source_dir=str(source_dir), countries="KZ,RU", stdout=out)
    assert set(Country.objects.values_list("code", flat=True)) == {"KZ", "RU"}
    assert City.objects.filter(name="Almaty").exists()
    assert not City.objects.filter(country_id="US").exists()
    assert "Импорт geo завершён" in out.getvalue()


def test_countries_all_imports_every_country_in_fixture(source_dir):
    call_command("import_geo", source_dir=str(source_dir), countries="all")
    assert set(Country.objects.values_list("code", flat=True)) == {
        "AL",
        "BY",
        "DE",
        "KZ",
        "RU",
        "US",
    }


def test_default_countries_constant_used_without_explicit_argument(source_dir, monkeypatch):
    # Подменяем список по умолчанию на пересечение с фикстурой, чтобы не
    # тянуть реальные 68 кодов мимо тестовых данных — команда обязана
    # использовать apps.geo.constants.DEFAULT_COUNTRY_CODES как фолбэк
    # именно через ссылку на модуль (не копию), поэтому патчим на месте.
    monkeypatch.setattr(
        "apps.geo.management.commands.import_geo.DEFAULT_COUNTRY_CODES",
        frozenset({"KZ"}),
    )
    call_command("import_geo", source_dir=str(source_dir))
    assert set(Country.objects.values_list("code", flat=True)) == {"KZ"}


def test_real_default_country_codes_constant_has_68_codes():
    # Не сама команда, а факт совпадения со стартовым списком плана
    # (68 кодов, синхронизирован вручную с web/groupLabels.ts — constants.py).
    assert len(DEFAULT_COUNTRY_CODES) == 68


def test_import_from_extracted_cities_txt_instead_of_zip(tmp_path):
    shutil.copy(DATA_DIR / "countryInfo_sample.txt", tmp_path / "countryInfo.txt")
    shutil.copy(DATA_DIR / "admin1CodesASCII_sample.txt", tmp_path / "admin1CodesASCII.txt")
    shutil.copy(DATA_DIR / "cities15000_sample.txt", tmp_path / "cities15000.txt")

    call_command("import_geo", source_dir=str(tmp_path), countries="all")
    assert City.objects.filter(name="Almaty").exists()
    assert Region.objects.filter(country_id="KZ", code="02").exists()


# --- --names-only (ADR-183: деплой новых флагов is_colloquial/is_short без
# повторного скачивания/разбора countryInfo.txt/admin1CodesASCII.txt/
# cities15000.zip) ---


@pytest.fixture
def names_only_dir(tmp_path) -> Path:
    """Каталог с ОДНИМ файлом имён `KZ.txt` (реальное имя источника было бы
    `<CC>.txt` на страну — здесь достаточно одного файла под кодом,
    реально присутствующим в справочнике фикстуры, чтобы проверить, что
    --names-only НЕ требует countryInfo.txt/admin1CodesASCII.txt/
    cities15000.zip вообще). ОТДЕЛЬНЫЙ подкаталог `tmp_path`, а не сам
    `tmp_path` — тесты, использующие ОБЕ фикстуры (`source_dir` +
    `names_only_dir`) в одном тесте, иначе делили бы один каталог (pytest
    даёт один и тот же `tmp_path` всем фикстурам одного теста) и KZ.txt
    оказался бы виден ещё ПЕРВОМУ (обычному) прогону import_geo."""
    directory = tmp_path / "names-only"
    directory.mkdir()
    shutil.copy(DATA_DIR / "alternatenames_sample.txt", directory / "KZ.txt")
    return directory


def test_names_only_and_skip_names_are_mutually_exclusive(source_dir):
    with pytest.raises(CommandError):
        call_command("import_geo", source_dir=str(source_dir), names_only=True, skip_names=True)


def test_names_only_requires_dir_or_download():
    with pytest.raises(CommandError, match="dir.*download|download.*dir"):
        call_command("import_geo", names_only=True)


def test_names_only_fails_when_no_countries_in_db_and_none_given(tmp_path):
    with pytest.raises(CommandError, match="нет ни одной страны"):
        call_command("import_geo", source_dir=str(tmp_path), names_only=True)


def test_names_only_does_not_require_country_admin1_cities_files(source_dir, names_only_dir):
    # Сначала — обычный импорт (страны/регионы/города), БЕЗ имён.
    call_command("import_geo", source_dir=str(source_dir), countries="KZ,RU")
    assert not CityName.objects.exists()

    # Затем --names-only с каталогом, в котором есть ТОЛЬКО KZ.txt — ни
    # countryInfo.txt, ни admin1CodesASCII.txt, ни cities15000.zip там нет,
    # и это не должно быть ошибкой.
    out = io.StringIO()
    call_command("import_geo", source_dir=str(names_only_dir), names_only=True, stdout=out)

    almaty = City.objects.get(name="Almaty")
    assert CityName.objects.filter(city=almaty).exists()
    assert "страны=0, регионы=0, города=0" in out.getvalue()


def test_names_only_without_explicit_countries_uses_existing_db_countries_not_default(
    source_dir, names_only_dir, monkeypatch
):
    # Без --countries --names-only берёт страны, УЖЕ ЕСТЬ в справочнике
    # (apps.geo.selectors.list_countries), а НЕ DEFAULT_COUNTRY_CODES —
    # подмена DEFAULT_COUNTRY_CODES на заведомо непересекающийся набор не
    # должна повлиять на результат.
    call_command("import_geo", source_dir=str(source_dir), countries="KZ,RU")
    monkeypatch.setattr(
        "apps.geo.management.commands.import_geo.DEFAULT_COUNTRY_CODES",
        frozenset({"US"}),
    )
    call_command("import_geo", source_dir=str(names_only_dir), names_only=True)
    almaty = City.objects.get(name="Almaty")
    assert CityName.objects.filter(city=almaty).exists()


def test_names_only_reimport_refreshes_flags_not_only_creates_rows(source_dir, names_only_dir):
    call_command("import_geo", source_dir=str(source_dir), countries="KZ,RU")
    call_command("import_geo", source_dir=str(names_only_dir), names_only=True)
    before = CityName.objects.count()

    call_command("import_geo", source_dir=str(names_only_dir), names_only=True)

    # Идемпотентно — повторный --names-only не плодит строки.
    assert CityName.objects.count() == before
