"""Read-слой apps.geo — данные для фильтра поиска (план 11.09 §4; поиск на
любом из наших языков — §2b, ADR-181).

Поиск на любом уровне — по названию НА ИСХОДНОМ ЯЗЫКЕ, латиницей И на любом
из наших языков (включая ИСТОРИЧЕСКИЕ имена — apps.geo.models.CityName/
RegionName, «Алма-Ата» обязана находить Алматы), регистронезависимо,
ПРЕФИКСОМ (не подстрокой — под подстроку нужен был бы триграммный индекс,
для фильтра «начните вводить город» префикса достаточно и он дешевле).
Регистронезависимость — через `Lower()` с обеих сторон (модуль geo/models.py
— почему это работает для кириллицы под "C"-коллацией колонки), НЕ через
`istartswith`/`icontains` Django (тот компилируется в `ILIKE`, а его
случай-фолдинг зависит от коллации, а не от LC_CTYPE — под "C" он не
свернул бы, например, "Алматы" и "алматы» к одному регистру).

Совпадение по имени НА ДРУГОМ ЯЗЫКЕ ищется через `pk__in=Subquery(...)` по
CityName/RegionName (не `JOIN` + `annotate`) — семантика SQL `IN`
(полу-соединение) не размножает строки City/Region, если у места совпало
сразу НЕСКОЛЬКО альтернативных имён (например запрос "alma" одновременно
матчит en-preferred "Almaty" и kk "Алматы" транслитерацией — не наш случай,
но конструкция защищает от дублей в принципе), поэтому дедуп/сортировка по
населению/keyset-пагинация родительского запроса не меняются вообще."""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field

from django.db.models import Q, QuerySet, Subquery
from django.db.models.functions import Lower

from .constants import normalize_generic_terms
from .models import City, CityName, Country, Region, RegionName

REGION_CODE_SEP = "-"

CITY_LIMIT_DEFAULT = 20
CITY_LIMIT_MAX = 50
REGION_LIMIT_DEFAULT = 50
REGION_LIMIT_MAX = 200


class InvalidRegionCodeError(ValueError):
    """Значение `region=` не разбирается как `<страна><SEP><код>`."""


class InvalidCityCursorError(ValueError):
    """Курсор `/v1/geo/cities` не разбирается."""


def list_countries() -> QuerySet[Country]:
    """GET /v1/geo/countries — активные страны справочника. Названий нет
    (models.Country) — фронт локализует код сам."""
    return Country.objects.filter(is_active=True).order_by("code")


def format_region_code(region: Region) -> str:
    """Публичный (composite, глобально уникальный) код региона для API:
    `<страна><SEP><код источника>`, например `KZ-02`. Модельное поле
    `Region.code` уникально только В ПАРЕ со страной (models.py), поэтому
    наружу отдаём составной идентификатор — им можно фильтровать города
    БЕЗ отдельного `country=`."""
    return f"{region.country_id}{REGION_CODE_SEP}{region.code}"


def parse_region_code(value: str) -> tuple[str, str]:
    """`KZ-02` → (`KZ`, `02`). Код страны — всегда 2 буквы (ISO 3166-1
    alpha-2), поэтому раздел ищем по фиксированной позиции, а не по первому
    вхождению разделителя (сам код источника у некоторых стран может
    начинаться с не-цифры и в принципе содержать дефис)."""
    if len(value) < 4 or value[2] != REGION_CODE_SEP:
        raise InvalidRegionCodeError(value)
    country_code = value[:2].upper()
    local_code = value[3:]
    if not local_code:
        raise InvalidRegionCodeError(value)
    return country_code, local_code


def search_regions(
    *, country: str | None, q: str | None, limit: int = REGION_LIMIT_DEFAULT
) -> list[Region]:
    """GET /v1/geo/regions?country=&q= — регионы, префиксный поиск по
    названию (исходное, латиницей, ИЛИ на любом из наших языков — включая
    исторические имена, apps.geo.models.RegionName). И `country`, и `q`
    необязательны: без обоих — просто активные регионы (используется редко,
    датасет небольшой, единицы тысяч строк на весь мир). `limit` — уже
    провалидирован вызывающей view (api/views.py): здесь ему доверяют как есть."""
    qs = Region.objects.filter(is_active=True).select_related("country")
    if country:
        qs = qs.filter(country_id=country.strip().upper())
    if q:
        needle = q.strip().lower()
        if needle:
            alt_region_ids = (
                RegionName.objects.annotate(name_lower=Lower("name"))
                .filter(name_lower__startswith=needle)
                .values("region_id")
            )
            qs = qs.annotate(name_lower=Lower("name"), name_latin_lower=Lower("name_latin")).filter(
                Q(name_lower__startswith=needle)
                | Q(name_latin_lower__startswith=needle)
                | Q(pk__in=Subquery(alt_region_ids))
            )
    return list(qs.order_by("name")[:limit])


def _encode_city_cursor(city: City) -> str:
    raw = f"{city.population}|{city.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_city_cursor(cursor: str) -> tuple[int, int]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        population_raw, _, id_raw = raw.partition("|")
        return int(population_raw), int(id_raw)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise InvalidCityCursorError(cursor) from exc


def list_cities(
    *,
    country: str | None,
    region: str | None,
    q: str | None,
    limit: int = CITY_LIMIT_DEFAULT,
    cursor: str | None = None,
) -> dict[str, object]:
    """GET /v1/geo/cities?country=&region=&q=&limit=&cursor= — страница
    городов, «сначала крупные» (population DESC), keyset-пагинация по
    (population, id) — тот же приём, что apps.notifications.selectors.
    feed_for_recipient, но по убыванию НЕ даты, а населения.

    `q` матчит `name`/`name_latin` ИЛИ имя на любом из наших языков
    (`apps.geo.models.CityName`, включая исторические — «Алма-Ата» находит
    Алматы); дублей на выходе не возникает (полу-соединение `pk__in=
    Subquery(...)`, не JOIN), ORDER BY/keyset-пагинация не меняются.

    `region` — составной код из `format_region_code` (например `KZ-02`);
    если задан, он ГЛАВНЕЕ отдельного `country` (тот при расхождении с
    кодом страны внутри `region` игнорируется — сам `region` уже
    самодостаточен). Возвращает `{"items": [City...], "next_cursor": str|None}`.
    `limit` — уже провалидирован вызывающей view (диапазон 1..CITY_LIMIT_MAX,
    иначе 400 до этого вызова)."""
    qs: QuerySet[City] = City.objects.filter(is_active=True).select_related("country", "region")

    if region:
        region_country, local_code = parse_region_code(region)
        qs = qs.filter(country_id=region_country, region__code=local_code)
    elif country:
        qs = qs.filter(country_id=country.strip().upper())

    if q:
        needle = q.strip().lower()
        if needle:
            alt_city_ids = (
                CityName.objects.annotate(name_lower=Lower("name"))
                .filter(name_lower__startswith=needle)
                .values("city_id")
            )
            qs = qs.annotate(name_lower=Lower("name"), name_latin_lower=Lower("name_latin")).filter(
                Q(name_lower__startswith=needle)
                | Q(name_latin_lower__startswith=needle)
                | Q(pk__in=Subquery(alt_city_ids))
            )

    if cursor:
        after_population, after_id = _decode_city_cursor(cursor)
        qs = qs.filter(
            Q(population__lt=after_population) | Q(population=after_population, id__lt=after_id)
        )

    rows = list(qs.order_by("-population", "-id")[: limit + 1])
    has_more = len(rows) > limit
    items = rows[:limit]
    return {
        "items": items,
        "next_cursor": _encode_city_cursor(items[-1]) if has_more and items else None,
    }


def find_cities_by_exact_name(text: str) -> list[City]:
    """Точное (не префиксное, в отличие от `list_cities`) регистронезависимое
    совпадение свободного текста с `City.name`/`City.name_latin` ИЛИ любым
    `CityName.name` (любая наша локаль, включая исторические имена) — план
    11.09 §4, единственный потребитель — `apps.profiles.services.
    migrate_profile_geo_to_work_areas` (перенос старого `Profile.city_name`).

    Может вернуть НЕСКОЛЬКО городов (одноимённые города в разных странах —
    совпадение неоднозначно) — вызывающая сторона решает, что делать с этим
    (перенос использует находку, только если ровно одна)."""
    needle = text.strip().lower()
    if not needle:
        return []
    alt_city_ids = (
        CityName.objects.annotate(name_lower=Lower("name"))
        .filter(name_lower=needle)
        .values("city_id")
    )
    qs = (
        City.objects.filter(is_active=True)
        .select_related("country", "region")
        .annotate(name_lower=Lower("name"), name_latin_lower=Lower("name_latin"))
        .filter(
            Q(name_lower=needle) | Q(name_latin_lower=needle) | Q(pk__in=Subquery(alt_city_ids))
        )
    )
    return list(qs)


# === Аудит покрытия отображаемых имён (ADR-183, manage.py geo_name_audit) ===
#
# Владелец просит регулярно проверять прод: сколько городов/регионов
# остаются БЕЗ имени нужной локали (показываются латиницей — фолбэк
# `name_i18n[locale]` → `name` → `name_latin`, api/serializers.py) и сколько
# показываются разговорным/коротким именем (services.
# _names_by_locale_with_fallback — фолбэк, когда полной формы для локали нет
# вовсе, ADR-183 §«Дефект 1»). Читает данные КАК ОНИ ЕСТЬ в `name_i18n` —
# не пересчитывает и не изменяет ничего (это селектор, не сервис).


@dataclass(frozen=True)
class LocaleCoverageByCountry:
    """Покрытие имён ОДНОЙ локали для ОДНОЙ страны."""

    country: str
    total: int
    latin_fallback: int  # имени локали нет вовсе → показывается name/name_latin
    colloquial_or_short: int  # показывается разговорным/коротким именем (фолбэк)

    @property
    def full_form(self) -> int:
        """Показывается ПОЛНОЙ (не разговорной/короткой) формой на нужной локали."""
        return self.total - self.latin_fallback - self.colloquial_or_short


@dataclass(frozen=True)
class LocaleCoverageExample:
    """Один пример для отчёта — конкретный город/регион и что для него сейчас
    показывается (`shown_name=None` — латиница, имени локали нет вовсе)."""

    country: str
    name_latin: str
    shown_name: str | None


@dataclass(frozen=True)
class LocaleCoverageReport:
    """Итог `audit_city_name_coverage`/`audit_region_name_coverage` — ОДНА
    локаль, ОДИН тип объекта (город ИЛИ регион)."""

    kind: str  # "город" | "регион" — только для печати в команде
    locale: str
    by_country: list[LocaleCoverageByCountry] = field(default_factory=list)
    latin_examples: list[LocaleCoverageExample] = field(default_factory=list)
    colloquial_examples: list[LocaleCoverageExample] = field(default_factory=list)

    @property
    def total(self) -> int:
        return sum(row.total for row in self.by_country)

    @property
    def latin_fallback_total(self) -> int:
        return sum(row.latin_fallback for row in self.by_country)

    @property
    def colloquial_or_short_total(self) -> int:
        return sum(row.colloquial_or_short for row in self.by_country)


def _audit_name_coverage(
    *,
    kind: str,
    objects_qs: QuerySet[City] | QuerySet[Region],
    names_qs: QuerySet[CityName] | QuerySet[RegionName],
    fk_field: str,
    locale: str,
    limit: int,
) -> LocaleCoverageReport:
    """Общая реализация для `audit_city_name_coverage`/
    `audit_region_name_coverage` — City/Region и CityName/RegionName
    устроены зеркально (models.py), поэтому логика читается один раз.

    Тянет `(id, country, name_latin, name_i18n)` по ВСЕМ объектам
    отфильтрованного набора В ПАМЯТЬ (для прод-масштаба — низкие десятки
    тысяч городов, единицы тысяч регионов, ADR-179/ADR-181 — это дёшево) —
    сознательно НЕ агрегирует одним ORM-запросом с `Exists`/`GROUP BY`:
    так проще проверить корректность (тесты see test_selectors.py) и не
    зависеть от тонкостей Django при смешении аннотации коррелированным
    подзапросом с групповой агрегацией."""
    rows = list(objects_qs.values_list("id", "country_id", "name_latin", "name_i18n"))

    shown_by_id: dict[int, tuple[str, str, str | None]] = {}
    for obj_id, country, name_latin, name_i18n in rows:
        shown_by_id[obj_id] = (country, name_latin, (name_i18n or {}).get(locale))

    ids_with_shown = [obj_id for obj_id, (_, _, shown) in shown_by_id.items() if shown]
    # (obj_id, name) пар, где ЭТО ИМЕННО ИМЯ помечено разговорным/коротким —
    # сравнение по значению (`name_i18n` не хранит, КАКАЯ строка CityName/
    # RegionName была источником, только готовый текст), сверка ID+ТЕКСТ.
    # Текст в `name_i18n` прошёл `constants.normalize_generic_terms`
    # (services._select_best_names, ADR-183, доп. 12.09) — сырой
    # `CityName.name`/`RegionName.name` нормализуется здесь ТАК ЖЕ, иначе
    # «Ставрополье» (короткое) не совпало бы само с собой при сравнении
    # (в этом конкретном случае нормализация — no-op, но для родового слова
    # внутри разговорного/короткого имени сравнение иначе бы не сработало).
    colloquial_pairs: set[tuple[int, str]] = set()
    if ids_with_shown:
        colloquial_pairs = {
            (obj_id, normalize_generic_terms(name, locale))
            for obj_id, name in names_qs.filter(
                **{f"{fk_field}_id__in": ids_with_shown}, locale=locale
            )
            .filter(Q(is_colloquial=True) | Q(is_short=True))
            .values_list(f"{fk_field}_id", "name")
        }

    totals: dict[str, dict[str, int]] = {}
    latin_examples: list[LocaleCoverageExample] = []
    colloquial_examples: list[LocaleCoverageExample] = []
    for obj_id, (country, name_latin, shown) in sorted(
        shown_by_id.items(), key=lambda item: (item[1][0], item[1][1], item[0])
    ):
        bucket = totals.setdefault(country, {"total": 0, "latin_fallback": 0, "colloquial": 0})
        bucket["total"] += 1
        if not shown:
            bucket["latin_fallback"] += 1
            if len(latin_examples) < limit:
                latin_examples.append(LocaleCoverageExample(country, name_latin, None))
        elif (obj_id, shown) in colloquial_pairs:
            bucket["colloquial"] += 1
            if len(colloquial_examples) < limit:
                colloquial_examples.append(LocaleCoverageExample(country, name_latin, shown))

    by_country = [
        LocaleCoverageByCountry(
            country=country,
            total=stats["total"],
            latin_fallback=stats["latin_fallback"],
            colloquial_or_short=stats["colloquial"],
        )
        for country, stats in sorted(totals.items())
    ]
    return LocaleCoverageReport(
        kind=kind,
        locale=locale,
        by_country=by_country,
        latin_examples=latin_examples,
        colloquial_examples=colloquial_examples,
    )


def audit_region_name_coverage(
    *, locale: str, countries: frozenset[str] | None, limit: int
) -> LocaleCoverageReport:
    """`manage.py geo_name_audit` (ADR-183) — покрытие `Region.name_i18n[locale]`
    по странам: сколько регионов остались латиницей (имени локали нет вовсе)
    и сколько показываются разговорным/коротким именем (фолбэк,
    services._names_by_locale_with_fallback)."""
    qs = Region.objects.filter(is_active=True)
    if countries is not None:
        qs = qs.filter(country_id__in=countries)
    return _audit_name_coverage(
        kind="регион",
        objects_qs=qs,
        names_qs=RegionName.objects.all(),
        fk_field="region",
        locale=locale,
        limit=limit,
    )


def audit_city_name_coverage(
    *, locale: str, countries: frozenset[str] | None, limit: int
) -> LocaleCoverageReport:
    """См. `audit_region_name_coverage` — то же самое для City/CityName."""
    qs = City.objects.filter(is_active=True)
    if countries is not None:
        qs = qs.filter(country_id__in=countries)
    return _audit_name_coverage(
        kind="город",
        objects_qs=qs,
        names_qs=CityName.objects.all(),
        fk_field="city",
        locale=locale,
        limit=limit,
    )
