"""Use case apps.geo — импорт справочника из строк дампов GeoNames (ADR-179).

Вся запись в БД — здесь, не в management-команде (CLAUDE.md: бизнес-логика
не в командах/сигналах, только в services.py). Функции принимают уже
РАЗОБРАННЫЕ построчно источники (apps.geo.geonames.iter_*) — сеть/файлы/zip
им не известны, поэтому тесты кормят их обычными списками без файловой
системы.

Идемпотентность — `bulk_create(..., update_conflicts=True)` (Django 5.2,
Postgres `INSERT ... ON CONFLICT DO UPDATE`): повторный запуск на тех же
данных обновляет существующие строки по естественному ключу источника
(geonames_id / (country, code)), а не плодит дубли. Битые строки не валят
импорт: ошибка разбора ОДНОЙ строки — `continue` со счётчиком, не
исключение на весь запуск."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

from django.db.models import BooleanField, ExpressionWrapper, Q, QuerySet

from .constants import GEONAMES_LANG_TO_LOCALE, LOCALE_SCRIPT_RANGES, normalize_generic_terms
from .models import City, CityName, Country, Region, RegionName

logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 1000


@dataclass(frozen=True)
class ImportStats:
    countries: int
    regions: int
    cities: int
    skipped_rows: int
    # План 11.09 §2b (ADR-181) — подушевые имена (alternatenames); 0, если
    # импорт запущен с alt_name_rows=None (--skip-names, или geo_fixture в
    # тестах без имён — geo_fixture специально их не тянет).
    city_names: int = 0
    region_names: int = 0


def _chunks[T](items: list[T], size: int) -> Iterator[list[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _norm_country_code(raw: str) -> str | None:
    code = raw.strip().upper()
    if len(code) != 2 or not code.isalpha():
        return None
    return code


def import_countries(
    rows: Iterable[list[str]],
    *,
    countries: frozenset[str] | None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> tuple[int, int]:
    """countryInfo.txt (apps.geo.geonames.iter_country_info) → upsert Country.
    `countries=None` — без фильтра (все страны источника)."""
    batch: list[Country] = []
    skipped = 0
    for row in rows:
        code = _norm_country_code(row[0]) if row else None
        if code is None:
            logger.warning("import_geo: битая строка countryInfo.txt: %r", row)
            skipped += 1
            continue
        if countries is not None and code not in countries:
            continue
        batch.append(Country(code=code, is_active=True))

    written = 0
    for chunk in _chunks(batch, batch_size):
        Country.objects.bulk_create(
            chunk,
            update_conflicts=True,
            unique_fields=["code"],
            update_fields=["is_active", "updated_at"],
            batch_size=batch_size,
        )
        written += len(chunk)
    return written, skipped


def import_regions(
    rows: Iterable[list[str]],
    *,
    countries: frozenset[str] | None,
    existing_country_codes: frozenset[str],
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> tuple[int, int]:
    """admin1CodesASCII.txt (apps.geo.geonames.iter_admin1_codes) → upsert
    Region. `code` источника — `<country>.<admin1>` (например `KZ.02`): до
    точки — страна, после — код региона В ЭТОЙ стране (Region.models —
    почему это не настоящий ISO 3166-2). `existing_country_codes` —
    защита от FK-нарушения: регион страны, которой нет в уже
    импортированных Country (не входит в фильтр, либо отсутствует в
    countryInfo.txt), пропускается как битая строка, а не валит батч."""
    batch: list[Region] = []
    skipped = 0
    for row in rows:
        try:
            raw_code = row[0]
            country_raw, sep, local_code = raw_code.partition(".")
            if not sep:
                raise ValueError("нет '.' в admin1-коде")
            country_code = country_raw.strip().upper()
            local_code = local_code.strip()
            name = row[1].strip()
            name_latin = row[2].strip()
            geonames_id = int(row[3])
            if not local_code or not name:
                raise ValueError("пустой код или название")
        except (IndexError, ValueError) as exc:
            logger.warning("import_geo: битая строка admin1CodesASCII.txt: %r (%s)", row, exc)
            skipped += 1
            continue
        if countries is not None and country_code not in countries:
            continue
        if country_code not in existing_country_codes:
            logger.warning(
                "import_geo: регион %s.%s ссылается на неизвестную страну — пропущен",
                country_code,
                local_code,
            )
            skipped += 1
            continue
        batch.append(
            Region(
                country_id=country_code,
                code=local_code,
                name=name,
                name_latin=name_latin or name,
                geonames_id=geonames_id,
                is_active=True,
            )
        )

    written = 0
    for chunk in _chunks(batch, batch_size):
        Region.objects.bulk_create(
            chunk,
            update_conflicts=True,
            unique_fields=["country", "code"],
            update_fields=["name", "name_latin", "geonames_id", "is_active", "updated_at"],
            batch_size=batch_size,
        )
        written += len(chunk)
    return written, skipped


def load_region_map(*, countries: frozenset[str] | None) -> dict[tuple[str, str], int]:
    """(код страны, код региона источника) → Region.id — для связки City→Region
    при импорте городов. Регионов в мире тысячи — держать целиком в памяти
    дешевле, чем на каждый город делать отдельный SELECT."""
    qs = Region.objects.values_list("country_id", "code", "id")
    if countries is not None:
        qs = qs.filter(country_id__in=countries)
    return {(country_code, code): region_id for country_code, code, region_id in qs}


def import_cities(
    rows: Iterable[list[str]],
    *,
    countries: frozenset[str] | None,
    existing_country_codes: frozenset[str],
    region_map: dict[tuple[str, str], int],
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> tuple[int, int]:
    """cities15000.txt (apps.geo.geonames.iter_cities) → upsert City.
    Колонки (0-based, формат GeoNames "cities" — 19 полей): 0 geonameid,
    1 name, 2 asciiname, 8 country code, 10 admin1 code, 14 population."""
    batch: list[City] = []
    skipped = 0
    for row in rows:
        try:
            geonames_id = int(row[0])
            name = row[1].strip()
            name_latin = (row[2] or row[1]).strip()
            country_code = row[8].strip().upper()
            admin1_code = row[10].strip()
            population = int(row[14]) if row[14].strip() else 0
            if not name or len(country_code) != 2:
                raise ValueError("пустое имя или код страны")
        except (IndexError, ValueError) as exc:
            logger.warning("import_geo: битая строка cities15000.txt: %r (%s)", row, exc)
            skipped += 1
            continue
        if countries is not None and country_code not in countries:
            continue
        if country_code not in existing_country_codes:
            logger.warning(
                "import_geo: город %s (%s) ссылается на неизвестную страну — пропущен",
                name,
                country_code,
            )
            skipped += 1
            continue
        region_id = region_map.get((country_code, admin1_code)) if admin1_code else None
        batch.append(
            City(
                country_id=country_code,
                region_id=region_id,
                name=name,
                name_latin=name_latin or name,
                population=population,
                geonames_id=geonames_id,
                is_active=True,
            )
        )

    written = 0
    for chunk in _chunks(batch, batch_size):
        City.objects.bulk_create(
            chunk,
            update_conflicts=True,
            unique_fields=["geonames_id"],
            update_fields=[
                "country",
                "region",
                "name",
                "name_latin",
                "population",
                "is_active",
                "updated_at",
            ],
            batch_size=batch_size,
        )
        written += len(chunk)
    return written, skipped


def import_alternate_names(
    rows: Iterable[list[str]],
    *,
    city_id_by_geonames_id: dict[int, int],
    region_id_by_geonames_id: dict[int, int],
    lang_to_locale: dict[str, str] = GEONAMES_LANG_TO_LOCALE,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> tuple[int, int, int]:
    """`<CC>.txt`/`.zip` alternatenames (apps.geo.geonames.iter_alternate_names)
    → upsert CityName/RegionName. Возвращает (записано имён городов,
    записано имён регионов, пропущено строк).

    Строка попадает в справочник, только если ВЕРНО ОБА условия:
    - `geonameid` УЖЕ есть у нас как City ИЛИ Region (пространства id не
      пересекаются — geonameid глобально уникален по всей базе GeoNames,
      см. models.py); подушевой файл несёт имена для миллионов объектов
      (улицы, реки, посёлки — всё, что мельче нашего порога cities15000),
      подавляющее большинство строк отсеивается именно здесь;
    - `isolanguage` входит в наш набор локалей (`lang_to_locale` —
      `apps.geo.constants.GEONAMES_LANG_TO_LOCALE`); служебные метки
      источника (`link`, `wkdt`, `iata`, `unlc`, `post`, …) и языки без
      нашего пакета отсеиваются тем же способом — они просто не найдутся
      в словаре.

    Любая другая строка (битая, чужой язык, неизвестный geonameid) —
    тихо пропускается со счётчиком, не обрывает импорт."""
    city_batch: list[CityName] = []
    region_batch: list[RegionName] = []
    skipped = 0
    for row in rows:
        try:
            alt_id = int(row[0])
            geonames_id = int(row[1])
            lang = row[2].strip()
            name = row[3].strip()
        except (IndexError, ValueError):
            skipped += 1
            continue
        locale = lang_to_locale.get(lang) if lang else None
        if locale is None or not name:
            skipped += 1
            continue
        is_preferred = len(row) > 4 and row[4].strip() == "1"
        is_short = len(row) > 5 and row[5].strip() == "1"
        is_colloquial = len(row) > 6 and row[6].strip() == "1"
        is_historic = len(row) > 7 and row[7].strip() == "1"

        city_id = city_id_by_geonames_id.get(geonames_id)
        region_id = None if city_id is not None else region_id_by_geonames_id.get(geonames_id)
        if city_id is not None:
            city_batch.append(
                CityName(
                    city_id=city_id,
                    locale=locale,
                    name=name,
                    is_preferred=is_preferred,
                    is_historic=is_historic,
                    is_colloquial=is_colloquial,
                    is_short=is_short,
                    geonames_alt_name_id=alt_id,
                )
            )
        elif region_id is not None:
            region_batch.append(
                RegionName(
                    region_id=region_id,
                    locale=locale,
                    name=name,
                    is_preferred=is_preferred,
                    is_historic=is_historic,
                    is_colloquial=is_colloquial,
                    is_short=is_short,
                    geonames_alt_name_id=alt_id,
                )
            )
        else:
            skipped += 1

    city_written = 0
    for city_chunk in _chunks(city_batch, batch_size):
        CityName.objects.bulk_create(
            city_chunk,
            update_conflicts=True,
            unique_fields=["geonames_alt_name_id"],
            update_fields=[
                "city",
                "locale",
                "name",
                "is_preferred",
                "is_historic",
                "is_colloquial",
                "is_short",
                "updated_at",
            ],
            batch_size=batch_size,
        )
        city_written += len(city_chunk)

    region_written = 0
    for region_chunk in _chunks(region_batch, batch_size):
        RegionName.objects.bulk_create(
            region_chunk,
            update_conflicts=True,
            unique_fields=["geonames_alt_name_id"],
            update_fields=[
                "region",
                "locale",
                "name",
                "is_preferred",
                "is_historic",
                "is_colloquial",
                "is_short",
                "updated_at",
            ],
            batch_size=batch_size,
        )
        region_written += len(region_chunk)

    return city_written, region_written, skipped


def _select_best_names(queryset: QuerySet[Any], *, group_field: str, locale: str) -> dict[int, str]:
    """`DISTINCT ON (group_field)` — лучшее имя ОДНОЙ локали среди уже
    отфильтрованных (вызывающей стороной) неисторических/неразговорных/
    некоротких кандидатов (ADR-183: `is_historic`/`is_colloquial`/
    `is_short` в отображение НИКОГДА не попадают — только в поиск,
    apps.geo.selectors). Порядок отбора внутри группы:

    1. `-is_preferred` — предпочитаемое (каноничное) имя локали побеждает;
    2. ТОЛЬКО для локалей с нелатинским письмом (`constants.
       LOCALE_SCRIPT_RANGES`) — кандидат, содержащий хотя бы один символ
       РОДНОЙ письменности локали, побеждает над тем, что не содержит:
       GeoNames изредка помечает такой локалью (например `ru`) строку,
       которая на деле — латинская транслитерация без единого
       флага-подсказки (найдено на живых данных, ADR-183 §«Дефект 2»:
       geonameid 487846 «Ставрополь» — alternateNameId 3738190
       `ru`=«Stavropol’» ЛАТИНИЦЕЙ (апостроф U+2019 — уже не ASCII, поэтому
       проверка «есть не-ASCII символ» тут НЕ СРАБОТАЛА БЫ, нужна проверка
       именно по диапазону скрипта) и 5961934 `ru`=«Ставрополь» КИРИЛЛИЦЕЙ,
       у обоих `is_preferred=False` — без этого тай-брейка побеждал
       случайный (по возрастанию id) кандидат);
    3. `id` — последний детерминированный тай-брейк (было единственным
       правилом тай-брейка до ADR-183).

    Для латинописьменных локалей (не входящих в LOCALE_SCRIPT_RANGES)
    поведение НЕ меняется — тай-брейк по `id`, как до ADR-183.

    Возвращаемый текст ПРОШЁЛ `constants.normalize_generic_terms` (ADR-183,
    доп. 12.09) — GeoNames отдаёт русские альтернативные имена регионов в
    Title Case («Ставропольский Край»), владелец просит официальную
    орфографию («Ставропольский край», родовое слово строчными, если оно
    не первое). Это ЕДИНСТВЕННАЯ точка, где выбранный текст попадает в
    `name_i18n` (и `refresh_city_name_i18n`, и `refresh_region_name_i18n`,
    и обе фолбэк-ветки `_names_by_locale_with_fallback` проходят через эту
    функцию) — сырые `CityName.name`/`RegionName.name` в БД не меняются
    (нужны для поиска — apps.geo.selectors, который обязан находить и по
    написанию источника)."""
    order_by = ["-is_preferred"]
    script_range = LOCALE_SCRIPT_RANGES.get(locale)
    if script_range is not None:
        queryset = queryset.annotate(
            has_native_script=ExpressionWrapper(
                Q(name__regex=f"[{script_range}]"), output_field=BooleanField()
            )
        )
        order_by.append("-has_native_script")
    order_by.append("id")
    rows = (
        queryset.order_by(group_field, *order_by)
        .distinct(group_field)
        .values_list(group_field, "name")
    )
    return {obj_id: normalize_generic_terms(name, locale) for obj_id, name in rows}


def _names_by_locale_with_fallback(
    model: type[CityName] | type[RegionName],
    *,
    group_field: str,
    ids: list[int],
    locale: str,
) -> dict[int, str]:
    """Лучшее имя локали на объект — ПОЛНАЯ форма (не `is_historic`, не
    `is_colloquial`, не `is_short`) в приоритете; для объектов, у которых
    для этой локали НЕТ НИ ОДНОГО кандидата полной формы, — фолбэк на
    разговорное/короткое (`is_historic=False`, БЕЗ дальнейших исключений).

    Фолбэк добавлен по факту (ADR-183 §«Дефект 1», проверено на живом
    RU-дампе): geonameid города Мурманск — единственный оставшийся
    (не-historic) кандидат локали `ru` — «Мурманск», но САМ ИСТОЧНИК метит
    его `isPreferred=1, isShort=1, isColloquial=1` (настоящих «полных»
    альтернатив нет вовсе, только исторические «Романов-на-Мурмане»/
    «Романов»/«Семёновский» и разговорные прозвища «столица Заполярья» и
    т.п.) — абсолютное исключение `is_short`/`is_colloquial` БЕЗ фолбэка
    оставило бы Мурманск вовсе без `ru`-имени (откат на латиницу `name`
    хуже, чем показать разговорное/короткое имя, которое и так является
    единственным реальным именем места на этом языке). `is_historic`
    фолбэка НЕ имеет — историческое имя (напр. «Алма-Ата») не показываем
    НИКОГДА, даже если это единственный кандидат локали."""
    base = model.objects.filter(**{f"{group_field}__in": ids}, locale=locale)
    full_form = base.filter(is_historic=False, is_colloquial=False, is_short=False)
    names = _select_best_names(full_form, group_field=group_field, locale=locale)
    missing = set(ids) - names.keys()
    if missing:
        fallback_qs = base.filter(**{f"{group_field}__in": missing}, is_historic=False)
        names.update(_select_best_names(fallback_qs, group_field=group_field, locale=locale))
    return names


def refresh_city_name_i18n(city_ids: Iterable[int], *, batch_size: int = DEFAULT_BATCH_SIZE) -> int:
    """Пересчитывает `City.name_i18n` из `CityName` для набора городов —
    ПОЛНОСТЬЮ КАЖДЫЙ РАЗ (не приращение), поэтому корректно отражает
    изменения источника между прогонами импорта (имя разжаловали из
    preferred, добавили новый язык и т.п.), а не только то, что было в
    ЭТОМ файле. Для каждой из наших локалей (`apps.geo.constants.
    LOCALE_TO_GEONAMES_LANGS`) — «лучшее» имя, `_names_by_locale_with_fallback`
    (ADR-183: разговорные/короткие имена в отображение попадают ТОЛЬКО если
    для локали нет полной формы вовсе; исторические — никогда; поиск,
    apps.geo.selectors, не фильтрует НИ один из этих флагов). Возвращает
    число обновлённых City."""
    city_ids = list(city_ids)
    if not city_ids:
        return 0

    # locale -> {city_id: имя} — индекс geo_city_name_refresh_idx (locale,
    # is_historic, is_colloquial, is_short, city, -is_preferred, id)
    # покрывает основной (полная форма) запрос; фолбэк-запрос — по
    # существенно меньшему множеству id (только «дыры» основного).
    per_locale: dict[str, dict[int, str]] = {}
    for locale in GEONAMES_LANG_TO_LOCALE.values():
        names = _names_by_locale_with_fallback(
            CityName, group_field="city_id", ids=city_ids, locale=locale
        )
        if names:
            per_locale[locale] = names

    cities = City.objects.in_bulk(city_ids)
    updated: list[City] = []
    for city_id, city in cities.items():
        name_i18n = {
            locale: names[city_id] for locale, names in per_locale.items() if city_id in names
        }
        if name_i18n != city.name_i18n:
            city.name_i18n = name_i18n
            updated.append(city)

    for chunk in _chunks(updated, batch_size):
        City.objects.bulk_update(chunk, ["name_i18n"], batch_size=batch_size)
    return len(updated)


def refresh_region_name_i18n(
    region_ids: Iterable[int], *, batch_size: int = DEFAULT_BATCH_SIZE
) -> int:
    """См. `refresh_city_name_i18n` — то же самое для Region/RegionName."""
    region_ids = list(region_ids)
    if not region_ids:
        return 0

    per_locale: dict[str, dict[int, str]] = {}
    for locale in GEONAMES_LANG_TO_LOCALE.values():
        names = _names_by_locale_with_fallback(
            RegionName, group_field="region_id", ids=region_ids, locale=locale
        )
        if names:
            per_locale[locale] = names

    regions = Region.objects.in_bulk(region_ids)
    updated: list[Region] = []
    for region_id, region in regions.items():
        name_i18n = {
            locale: names[region_id] for locale, names in per_locale.items() if region_id in names
        }
        if name_i18n != region.name_i18n:
            region.name_i18n = name_i18n
            updated.append(region)

    for chunk in _chunks(updated, batch_size):
        Region.objects.bulk_update(chunk, ["name_i18n"], batch_size=batch_size)
    return len(updated)


def import_alt_names_and_refresh(
    alt_name_rows: Iterable[list[str]],
    *,
    countries: frozenset[str] | None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> tuple[int, int, int]:
    """Импорт подушевых имён (`import_alternate_names`) + пересчёт
    `name_i18n` (ADR-181/ADR-183) ПО УЖЕ СУЩЕСТВУЮЩИМ City/Region — общая
    часть `import_geo_dataset` (полный прогон) и `import_geo_names_only`
    (деплой ADR-183: страны/регионы/города не меняются, нужно только
    доимпортировать имена с новыми флагами `is_colloquial`/`is_short` и
    пересчитать `name_i18n`, без повторного скачивания/разбора countryInfo/
    admin1/cities15000). Возвращает (записано имён городов, записано имён
    регионов, пропущено строк)."""
    city_qs = City.objects.values_list("geonames_id", "id")
    # Region.geonames_id — nullable (не у всех регионов источник даёт
    # geonames_id, models.py) — exclude() отсеивает NULL в самом
    # запросе, но mypy об этом не знает (тип колонки остаётся
    # `int | None`); фильтр `is not None` ниже — та же гарантия для
    # типов, без второго похода в БД.
    region_qs = Region.objects.exclude(geonames_id__isnull=True).values_list("geonames_id", "id")
    if countries is not None:
        city_qs = city_qs.filter(country_id__in=countries)
        region_qs = region_qs.filter(country_id__in=countries)
    city_id_by_geonames_id: dict[int, int] = dict(city_qs)
    region_id_by_geonames_id: dict[int, int] = {
        geonames_id: region_id for geonames_id, region_id in region_qs if geonames_id is not None
    }

    city_names_written, region_names_written, names_skipped = import_alternate_names(
        alt_name_rows,
        city_id_by_geonames_id=city_id_by_geonames_id,
        region_id_by_geonames_id=region_id_by_geonames_id,
        batch_size=batch_size,
    )
    refresh_city_name_i18n(city_id_by_geonames_id.values(), batch_size=batch_size)
    refresh_region_name_i18n(region_id_by_geonames_id.values(), batch_size=batch_size)
    return city_names_written, region_names_written, names_skipped


def import_geo_dataset(
    *,
    country_rows: Iterable[list[str]],
    admin1_rows: Iterable[list[str]],
    city_rows: Iterable[list[str]],
    countries: frozenset[str] | None,
    alt_name_rows: Iterable[list[str]] | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> ImportStats:
    """Полный прогон: страны → регионы → карта регионов → города → (если
    `alt_name_rows` задан — план 11.09 §2b, `--skip-names` в management-
    команде передаёт `None`) подушевые имена + пересчёт `name_i18n` (в этом
    порядке — города и регионы ссылаются на страны, города — на регионы,
    имена — на уже существующие City/Region)."""
    countries_written, countries_skipped = import_countries(
        country_rows, countries=countries, batch_size=batch_size
    )
    # Country уже отфильтрован по `countries` предыдущим шагом — достаточно
    # взять то, что реально попало в таблицу (а не гадать по параметру).
    existing_country_codes = frozenset(Country.objects.values_list("code", flat=True))
    regions_written, regions_skipped = import_regions(
        admin1_rows,
        countries=countries,
        existing_country_codes=existing_country_codes,
        batch_size=batch_size,
    )
    region_map = load_region_map(countries=countries)
    cities_written, cities_skipped = import_cities(
        city_rows,
        countries=countries,
        existing_country_codes=existing_country_codes,
        region_map=region_map,
        batch_size=batch_size,
    )

    city_names_written = region_names_written = names_skipped = 0
    if alt_name_rows is not None:
        city_names_written, region_names_written, names_skipped = import_alt_names_and_refresh(
            alt_name_rows, countries=countries, batch_size=batch_size
        )

    return ImportStats(
        countries=countries_written,
        regions=regions_written,
        cities=cities_written,
        skipped_rows=countries_skipped + regions_skipped + cities_skipped + names_skipped,
        city_names=city_names_written,
        region_names=region_names_written,
    )
