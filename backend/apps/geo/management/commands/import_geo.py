"""manage.py import_geo — импорт справочника геосправочника из дампов
GeoNames (ADR-179, план 11.09 §3; подушевые имена — ADR-181, план 11.09
§2b; флаги is_colloquial/is_short и --names-only — ADR-183).

Тонкая CLI-обёртка (CLAUDE.md — бизнес-логика не в командах): разбирает
аргументы, находит/скачивает файлы источника, отдаёт их построчные
читалки (apps.geo.geonames) в services.import_geo_dataset /
services.import_alt_names_and_refresh."""

from __future__ import annotations

import tempfile
import urllib.error
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.geo import geonames, selectors, services
from apps.geo.constants import DEFAULT_COUNTRY_CODES


class Command(BaseCommand):
    help = (
        "Импорт справочника страна/регион/город из дампов GeoNames "
        "(https://download.geonames.org/export/dump/): countryInfo.txt, "
        "admin1CodesASCII.txt, cities15000.zip, alternatenames/<CC>.zip "
        "(названия на разных языках — план 11.09 §2b, --skip-names отключает; "
        "--names-only — только имена поверх уже импортированного справочника, "
        "ADR-183)."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--dir",
            dest="source_dir",
            default=None,
            help=(
                "Каталог с уже скачанными countryInfo.txt, admin1CodesASCII.txt, "
                "cities15000.zip (или распакованным cities15000.txt) и, если не "
                "передан --skip-names, подушевыми alternatenames/<CC>.zip (или "
                "<CC>.txt) под НАСТОЯЩИМИ именами GeoNames прямо в этом каталоге. "
                "С --names-only каталогу достаточно ТОЛЬКО alternatenames/<CC>.zip "
                "— остальные три файла не нужны. Взаимоисключимо с --download."
            ),
        )
        parser.add_argument(
            "--download",
            action="store_true",
            help="Скачать файлы источника во временный каталог перед импортом.",
        )
        parser.add_argument(
            "--countries",
            default=None,
            help=(
                "Коды ISO 3166-1 alpha-2 через запятую (например RU,KZ,BY) или "
                "'all' — все страны источника. По умолчанию — стартовый список "
                f"из {len(DEFAULT_COUNTRY_CODES)} стран (apps.geo.constants."
                "DEFAULT_COUNTRY_CODES). Справочник расширяется без правки кода: "
                "передайте свой список или 'all'."
            ),
        )
        parser.add_argument(
            "--skip-names",
            action="store_true",
            help=(
                "Не качать/не импортировать подушевые файлы имён "
                "(alternatenames/<CC>.zip) — только страны/регионы/города, как до "
                "плана 11.09 §2b. Название на языке зрителя и поиск не латиницей "
                "тогда останутся недоступны для стран этого прогона."
            ),
        )
        parser.add_argument(
            "--names-only",
            action="store_true",
            help=(
                "Только подушевые имена (alternatenames/<CC>.zip) + пересчёт "
                "name_i18n ПОВЕРХ уже импортированных стран/регионов/городов — "
                "не скачивает и не разбирает countryInfo.txt/admin1CodesASCII.txt/"
                "cities15000.zip вообще (ADR-183: те три файла не меняются, когда "
                "меняется только разбор имён — is_colloquial/is_short). Список "
                "стран — как в --countries, а без него — все страны, УЖЕ ЕСТЬ в "
                "справочнике (не DEFAULT_COUNTRY_CODES). Взаимоисключимо с "
                "--skip-names."
            ),
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=services.DEFAULT_BATCH_SIZE,
            help=f"Размер пачки bulk_create (по умолчанию {services.DEFAULT_BATCH_SIZE}).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        source_dir_opt = options["source_dir"]
        download = bool(options["download"])
        if not source_dir_opt and not download:
            raise CommandError("Укажите --dir с уже скачанными файлами или --download")
        if source_dir_opt and download:
            raise CommandError("--dir и --download взаимоисключимы")

        batch_size = int(options["batch_size"])
        skip_names = bool(options["skip_names"])
        names_only = bool(options["names_only"])
        if names_only and skip_names:
            raise CommandError("--names-only и --skip-names взаимоисключимы")
        # Без явного --countries: обычный прогон падает на DEFAULT_COUNTRY_CODES
        # (стартовый список плана), а --names-only — на None (резолвится в
        # _handle_names_only через страны, УЖЕ ЕСТЬ в справочнике, а не на
        # фиксированный стартовый список — иначе --names-only без --countries
        # молча расширил бы набор стран вместо того, чтобы обновить имеющиеся).
        countries = self._parse_countries(
            options["countries"], omitted_default=None if names_only else DEFAULT_COUNTRY_CODES
        )

        if names_only:
            stats = self._handle_names_only(
                source_dir_opt=source_dir_opt,
                download=download,
                countries=countries,
                batch_size=batch_size,
            )
        elif download:
            with tempfile.TemporaryDirectory(prefix="geo-import-") as tmp:
                source_dir = Path(tmp)
                self.stdout.write(f"Скачиваю дампы GeoNames в {source_dir}…")
                geonames.download_dump(source_dir)
                target_codes = self._resolve_target_codes(source_dir, countries)
                if not skip_names:
                    self._download_alternate_names(source_dir, target_codes)
                stats = self._run_import(
                    source_dir,
                    countries=countries,
                    target_codes=target_codes,
                    skip_names=skip_names,
                    batch_size=batch_size,
                )
        else:
            source_dir = Path(str(source_dir_opt))
            if not source_dir.is_dir():
                raise CommandError(f"Каталог не найден: {source_dir}")
            target_codes = self._resolve_target_codes(source_dir, countries)
            stats = self._run_import(
                source_dir,
                countries=countries,
                target_codes=target_codes,
                skip_names=skip_names,
                batch_size=batch_size,
            )

        self.stdout.write(
            self.style.SUCCESS(
                f"Импорт geo завершён: страны={stats.countries}, регионы={stats.regions}, "
                f"города={stats.cities}, имена городов={stats.city_names}, "
                f"имена регионов={stats.region_names}, "
                f"пропущено битых строк={stats.skipped_rows}"
            )
        )

    def _handle_names_only(
        self,
        *,
        source_dir_opt: str | None,
        download: bool,
        countries: frozenset[str] | None,
        batch_size: int,
    ) -> services.ImportStats:
        """ADR-183 «Деплой»: страны/регионы/города не трогаем — только
        подушевые имена (у УЖЕ импортированных объектов) + пересчёт
        name_i18n. Список стран без явного --countries — те, что реально
        УЖЕ есть в справочнике (`selectors.list_countries`), а не
        `DEFAULT_COUNTRY_CODES`: цель — доимпортировать новые флаги там,
        где справочник уже выкачен, а не расширить набор стран."""
        target_codes = (
            countries
            if countries is not None
            else frozenset(selectors.list_countries().values_list("code", flat=True))
        )
        if not target_codes:
            raise CommandError(
                "--names-only: в справочнике нет ни одной страны — сначала обычный "
                "прогон import_geo (без --names-only)"
            )
        if download:
            with tempfile.TemporaryDirectory(prefix="geo-import-names-") as tmp:
                source_dir = Path(tmp)
                self._download_alternate_names(source_dir, target_codes)
                return self._run_names_only_import(
                    source_dir,
                    countries=countries,
                    target_codes=target_codes,
                    batch_size=batch_size,
                )
        source_dir = Path(str(source_dir_opt))
        if not source_dir.is_dir():
            raise CommandError(f"Каталог не найден: {source_dir}")
        return self._run_names_only_import(
            source_dir, countries=countries, target_codes=target_codes, batch_size=batch_size
        )

    def _run_names_only_import(
        self,
        source_dir: Path,
        *,
        countries: frozenset[str] | None,
        target_codes: frozenset[str],
        batch_size: int,
    ) -> services.ImportStats:
        alt_name_rows = self._iter_alternate_name_rows(source_dir, target_codes)
        city_names_written, region_names_written, names_skipped = (
            services.import_alt_names_and_refresh(
                alt_name_rows, countries=countries, batch_size=batch_size
            )
        )
        return services.ImportStats(
            countries=0,
            regions=0,
            cities=0,
            skipped_rows=names_skipped,
            city_names=city_names_written,
            region_names=region_names_written,
        )

    @staticmethod
    def _parse_countries(
        raw: object, *, omitted_default: frozenset[str] | None
    ) -> frozenset[str] | None:
        if raw is None:
            return omitted_default
        text = str(raw).strip()
        if text.lower() == "all":
            return None
        codes = {chunk.strip().upper() for chunk in text.split(",") if chunk.strip()}
        if not codes:
            raise CommandError("--countries: пустой список")
        return frozenset(codes)

    def _resolve_target_codes(
        self, source_dir: Path, countries: frozenset[str] | None
    ) -> frozenset[str]:
        """Конкретный список кодов страны для подушевых файлов имён:
        `countries`, если задан явно, иначе — все валидные коды прямо из
        `countryInfo.txt` этого прогона (`--countries=all` не даёт списка
        заранее, а качать/искать файл имён нужно по КАЖДОЙ реальной стране
        источника)."""
        if countries is not None:
            return countries
        country_info_path = source_dir / geonames.COUNTRY_INFO_FILENAME
        if not country_info_path.exists():
            raise CommandError(f"Файл не найден: {country_info_path}")
        codes: set[str] = set()
        for row in geonames.iter_country_info(country_info_path):
            code = row[0].strip().upper() if row else ""
            if len(code) == 2 and code.isalpha():
                codes.add(code)
        return frozenset(codes)

    def _download_alternate_names(self, source_dir: Path, target_codes: frozenset[str]) -> None:
        self.stdout.write(f"Скачиваю имена ({len(target_codes)} стран)…")
        for code in sorted(target_codes):
            try:
                geonames.download_alternate_names(source_dir, country_code=code)
            except urllib.error.HTTPError as exc:
                # Не у каждого кода источника есть файл имён (мелкие/спорные
                # территории) — пропуск ОДНОЙ страны не должен валить прогон.
                self.stdout.write(self.style.WARNING(f"Имена {code}: {exc} — пропущено"))

    @staticmethod
    def _iter_alternate_name_rows(
        source_dir: Path, target_codes: frozenset[str]
    ) -> Iterator[list[str]]:
        """Ленивая склейка построчных читалок `<CC>.zip`/`<CC>.txt` по всем
        `target_codes`, которые реально нашлись в `source_dir` — код без
        файла (не скачался/не был передан руками) тихо пропускается, не
        обрывает импорт остальных стран."""
        for code in sorted(target_codes):
            zip_path = source_dir / geonames.alternate_names_zip_filename(code)
            txt_path = source_dir / f"{code}.txt"
            path = txt_path if txt_path.exists() else zip_path
            if not path.exists():
                continue
            yield from geonames.iter_alternate_names(path, country_code=code)

    def _run_import(
        self,
        source_dir: Path,
        *,
        countries: frozenset[str] | None,
        target_codes: frozenset[str],
        skip_names: bool,
        batch_size: int,
    ) -> services.ImportStats:
        country_info_path = source_dir / geonames.COUNTRY_INFO_FILENAME
        admin1_path = source_dir / geonames.ADMIN1_CODES_FILENAME
        cities_zip_path = source_dir / geonames.CITIES_ZIP_FILENAME
        cities_txt_path = source_dir / geonames.CITIES_TXT_FILENAME
        cities_path = cities_txt_path if cities_txt_path.exists() else cities_zip_path

        for path in (country_info_path, admin1_path):
            if not path.exists():
                raise CommandError(f"Файл не найден: {path}")
        if not cities_path.exists():
            raise CommandError(
                f"Не найден ни {cities_zip_path.name}, ни {cities_txt_path.name} в {source_dir}"
            )

        alt_name_rows: Iterable[list[str]] | None = None
        if not skip_names:
            alt_name_rows = self._iter_alternate_name_rows(source_dir, target_codes)

        return services.import_geo_dataset(
            country_rows=geonames.iter_country_info(country_info_path),
            admin1_rows=geonames.iter_admin1_codes(admin1_path),
            city_rows=geonames.iter_cities(cities_path),
            countries=countries,
            alt_name_rows=alt_name_rows,
            batch_size=batch_size,
        )
