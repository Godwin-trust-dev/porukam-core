"""Справочник географии (страна → регион → город) — план 11.09 §2, ADR-179.

НИЖНИЙ слой (CLAUDE.md, как apps.catalog/jurisdictions/l10n): ни от кого не
зависит, данные заполняются командой импорта `manage.py import_geo` из
открытых дампов GeoNames (CC BY 4.0 — источник указывается в юр-документах
платформы, ADR-179 §«Атрибуция»), не руками и не сигналами.

Эта миграция — ТОЛЬКО справочник и его API (план 11.09, часть 2). Привязка
`apps.profiles.Profile` к City/Region — часть 4 плана, сюда НЕ входит.

Коллация текстовых полей, участвующих в поиске (`name`, `name_latin`,
`Region.code`), — явно `"C"` (встроенная, детерминированная коллация
Postgres, побайтовое сравнение):
- `LIKE`/`ILIKE`/`istartswith` в Postgres ЗАПРЕЩЕНЫ под недетерминированной
  коллацией (см. ловушку `apps.social.selectors.search_handles` — там
  используется НЕ collation колонки, а `Collate(..., "C")` в аннотации,
  потому что колонка лежит под именованной нон-детерминированной ICU-
  коллацией `case_insensitive`, нужной для регистронезависимого РАВЕНСТВА
  хендла). Здесь регистронезависимое равенство не нужно — только префиксный
  поиск, поэтому проще и дешевле объявить колонку сразу `"C"`, не заводя
  свою ICU-коллацию и не завися от `apps.accounts` (её `case_insensitive`
  создаётся миграцией accounts, а geo — нижний слой и ничего оттуда
  импортировать/зависеть не должен даже на уровне порядка миграций);
- `"C"` не зависит от того, какие ICU/glibc-локали установлены в ОС
  контейнера (dev/CI/прод могут расходиться), и допускает обычный
  btree-индекс для префиксного поиска (`LIKE 'x%'`) без `text_pattern_ops` —
  под локаль-зависимой коллацией такой индекс поддержки не даёт;
  сортировка по алфавиту "C" даёт побайтовый (не лингвистический) порядок,
  но здесь колонки используются для ПОИСКА, а не для отображения списка по
  алфавиту, так что это не проблема.
- поиск регистронезависим не за счёт коллации, а за счёт того, что
  сравнение всегда идёт по нижнему регистру: `Lower()` — ФУНКЦИЯ Postgres
  (`lower()`/`upper()`). Индексы под префиксный поиск поэтому — ФУНКЦИОНАЛЬНЫЕ,
  по `Lower(name)`/`Lower(name_latin)` (`selectors.py` фильтрует именно по
  ним), а не по сырому полю: plain-индекс по `name` не покрыл бы `WHERE
  lower(name) LIKE ...`.

ВАЖНОЕ УТОЧНЕНИЕ (найдено при разработке ADR-181, план 11.09 §2b — здесь,
в `Country`/`Region`/`City`, поведение видно, но НЕ проверено тестами, а
латинские `name`/`name_latin` этой ошибки просто не показывают): `lower()`
в Postgres — НЕ LC_CTYPE-осведомлённый, а КОЛЛАЦИЯ-осведомлённый (проверено
на реальном Postgres 16 этого проекта: `SELECT lower('АЛМАТЫ' COLLATE "C")`
→ `'АЛМАТЫ'` НЕ сворачивается, `SELECT lower('АЛМАТЫ' COLLATE "default")`
→ `'алматы'` сворачивается верно; то же для латинских диакритик, `Ü`→`ü`
под "C" тоже не работает). Под явной коллацией `"C"` (byte-comparison,
POSIX/ASCII case rules) `lower()`/`upper()` сворачивают ТОЛЬКО ASCII A-Z —
кириллица, армянский, диакритика и т.п. остаются как есть. Для `Country`/
`Region.name`/`City.name` это не проявилось только потому, что GeoNames
`cities15000.txt`/`admin1CodesASCII.txt` дают `name` уже переведённым в
основном на латиницу для стран текущей фикстуры (docstring `City` ниже) —
это НЕ гарантия на все страны источника, а везение конкретной выборки;
если у какой-то реальной страны `name` окажется кириллицей/греческим с
заглавной буквы, `WHERE lower(name) LIKE 'префикс%'` для нее в текущем
коде не сработает. Затронутая ошибка — существующее (до этой ветки)
поведение `Region`/`City`, оставлена как есть (эта ветка ограничена
`apps.geo.CityName/RegionName`, план 11.09 §2b — см. ADR-181 «Пределы
задачи»): `CityName`/`RegionName` ниже НЕ используют коллацию `"C"` для
`name` именно по этой причине (они хранят НАСТОЯЩИЕ многоязычные названия,
где кириллица/армянский с заглавной буквы — норма, а не исключение) —
обычная (дефолтная collation базы) колонка + функциональный индекс с
`django.contrib.postgres.indexes.OpClass(Lower("name"), name=
"text_pattern_ops")` (Django требует `OpClass`, а не `Index(opclasses=...)`,
когда индекс строится по ВЫРАЖЕНИЮ, не по полю) — `text_pattern_ops`
восстанавливает для `LIKE 'x%'` под НЕ-`"C"`-коллацией ту же
btree-поддержку префиксного поиска, которую `"C"` даёт бесплатно (проверено
`EXPLAIN` на реальном Postgres: `Bitmap Index Scan` по этому индексу для
`lower(name) LIKE 'алматы%'`)."""

from __future__ import annotations

from django.contrib.postgres.indexes import OpClass
from django.db import models
from django.db.models.functions import Lower

_SEARCH_COLLATION = "C"


class Country(models.Model):
    """Страна — код ISO 3166-1 alpha-2 как первичный ключ.

    Названия стран сознательно НЕ храним: фронт локализует их сам через
    `Intl.DisplayNames` (уже сделано в `web/src/features/groups/
    groupLabels.ts::countryName`) — держать переводы названий 200+ стран на
    29 локалях в БД было бы дублированием того, что браузер уже умеет
    бесплатно и точнее (в т.ч. для локалей, которых нет в l10n-пакетах).
    """

    code = models.CharField(max_length=2, primary_key=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "geo_country"
        verbose_name = "страна"
        verbose_name_plural = "страны"
        ordering = ["code"]

    def __str__(self) -> str:
        return self.code


class Region(models.Model):
    """Регион/область/штат (первый уровень административного деления).

    `code` — код региона ИЗ ИСТОЧНИКА (GeoNames `admin1 code`, файл
    admin1CodesASCII.txt), НЕ настоящий ISO 3166-2: GeoNames не публикует
    чистые ISO 3166-2 коды для всех стран — например, для Казахстана это
    внутренние числовые коды GeoNames (`02`, `1537272`, `12510143`), а не
    `KZ-75`/`KZ-ALA` (проверено на реальном дампе при разработке ADR-179).
    Поле называется `code`, а не `geonames_admin1_code`, потому что для
    большинства стран источника (ISO-код совпадает с реальным ISO 3166-2)
    разницы нет, а завязываться на дословное имя одного конкретного
    источника — усложнение, которого просят избегать; смысловая гарантия
    ровно та, что просил владелец: код уникален В ПАРЕ СО СТРАНОЙ
    (`UniqueConstraint` ниже), НЕ обязательно глобально и НЕ обязательно
    официальный ISO. Если понадобится настоящий ISO 3166-2 — отдельная
    задача с другим источником данных (см. ADR-179).

    `region` может отсутствовать у City (не у каждой страны есть деление
    первого уровня в GeoNames), поэтому Region ссылается на City через
    `related_name="cities"`, а не наоборот.
    """

    country = models.ForeignKey(Country, on_delete=models.PROTECT, related_name="regions")
    code = models.CharField(max_length=20, db_collation=_SEARCH_COLLATION)
    name = models.CharField(max_length=200, db_collation=_SEARCH_COLLATION)
    name_latin = models.CharField(max_length=200, db_collation=_SEARCH_COLLATION)
    # Код локали (BCP-47, как в apps.l10n) → название на языке зрителя —
    # ГОТОВОЕ (предпочитаемое имя локали, а при его отсутствии — любое
    # непустое НЕисторическое имя локали), план 11.09 §2b, ADR-181.
    # Заполняется/пересчитывается командой импорта целиком при каждом
    # прогоне из RegionName (services.refresh_name_i18n) — читатель
    # (api/serializers.py) берёт значение по локали без JOIN'а, дальше
    # фолбэк на `name` → `name_latin`. Пустой словарь/отсутствие ключа —
    # для этой локали переводов не нашлось.
    name_i18n = models.JSONField(default=dict, blank=True)
    geonames_id = models.PositiveBigIntegerField(unique=True, null=True, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "geo_region"
        verbose_name = "регион"
        verbose_name_plural = "регионы"
        ordering = ["country_id", "code"]
        constraints = [
            models.UniqueConstraint(
                fields=["country", "code"], name="geo_region_country_code_uniq"
            ),
        ]
        indexes = [
            models.Index(Lower("name"), name="geo_region_name_lower_idx"),
            models.Index(Lower("name_latin"), name="geo_region_name_lat_lower_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.country_id}-{self.code} {self.name}"


class City(models.Model):
    """Город — GeoNames `cities15000.txt` (населённые пункты от 15 000
    жителей, порог и его обоснование — ADR-179). Координаты НЕ храним: их
    негде применять (карты/расстояния — вне объёма фильтра поиска), а
    хранение точки в БД — лишний ПД-примыкающий риск без пользы.

    `geonames_id` — устойчивый внешний ключ источника, на нём держится
    идемпотентность повторного импорта (`bulk_create(..., update_conflicts=
    True)` по этому полю, apps.geo.services.import_cities) и связка
    City → Region (через `country_id` + `admin1 code` строки города —
    apps.geo.services.load_region_map).
    """

    country = models.ForeignKey(Country, on_delete=models.PROTECT, related_name="cities")
    region = models.ForeignKey(
        Region, on_delete=models.PROTECT, related_name="cities", null=True, blank=True
    )
    name = models.CharField(max_length=200, db_collation=_SEARCH_COLLATION)
    name_latin = models.CharField(max_length=200, db_collation=_SEARCH_COLLATION)
    # См. Region.name_i18n — то же назначение (пересчитывается из CityName).
    name_i18n = models.JSONField(default=dict, blank=True)
    population = models.PositiveIntegerField(default=0)
    geonames_id = models.PositiveBigIntegerField(unique=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "geo_city"
        verbose_name = "город"
        verbose_name_plural = "города"
        ordering = ["-population", "-id"]
        indexes = [
            models.Index(Lower("name"), name="geo_city_name_lower_idx"),
            models.Index(Lower("name_latin"), name="geo_city_name_lat_lower_idx"),
            # Фильтр «страна(+регион), сначала крупные» — основной запрос
            # /v1/geo/cities; -id вторым ключом — тот же keyset-порядок, что
            # использует пагинация в selectors.list_cities.
            models.Index(fields=["country", "-population", "-id"], name="geo_city_country_pop_idx"),
            models.Index(fields=["region", "-population", "-id"], name="geo_city_region_pop_idx"),
            models.Index(fields=["-population", "-id"], name="geo_city_pop_idx"),
        ]

    def __str__(self) -> str:
        return self.name


class RegionName(models.Model):
    """Название региона НА ОДНОМ ЯЗЫКЕ — план 11.09 §2b, ADR-181.

    Отдельная таблица, а не расширение `Region.name_i18n` (JSONField):
    префиксный поиск по значению внутри JSONB Postgres нормально не
    индексируется (GIN на jsonb_ops индексирует КЛЮЧИ/пути, не текст
    значений; `jsonb_path_ops` тем более не годится под `LIKE`) — обычная
    колонка + функциональный индекс по `Lower(name)` решает это без
    экзотики (ПОЧЕМУ без коллации `"C"`, в отличие от `Region.name`/
    `Region.name_latin`, и что такое `OpClass(..., "text_pattern_ops")` —
    докстринг модуля вверху файла, раздел «ВАЖНОЕ УТОЧНЕНИЕ»).

    Строка = одна запись подушевого файла GeoNames alternatenames
    (`https://download.geonames.org/export/dump/alternatenames/<CC>.zip`).
    `geonames_alt_name_id` — `alternateNameId` источника, глобально
    уникален по всей базе GeoNames (в отличие от City/Region, где
    натуральный ключ — `geonames_id`) — на нём держится идемпотентность
    повторного импорта (`bulk_create(..., update_conflicts=True)`,
    apps.geo.services.import_alternate_names).

    `locale` — НАШ код локали (BCP-47: `apps.l10n.Locale.code` или
    встроенная пара `common.i18n.SUPPORTED_LOCALES`), НЕ голый код языка
    GeoNames (`isolanguage`, обычно ISO 639-1) — сопоставление одного с
    другим — `apps.geo.constants.LOCALE_TO_GEONAMES_LANGS`, импорт пишет
    сюда уже переведённый локаль-код.

    `is_preferred` — GeoNames `isPreferred`: предпочитаемое (каноничное)
    имя ЭТОЙ локали для этого места — из него собирается `Region.name_i18n`
    (services.refresh_name_i18n). `is_historic` — GeoNames `isHistoric`
    (например «Алма-Ата» для Алматы): участвует в ПОИСКЕ
    (apps.geo.selectors — «Алма-Ата» обязана находить Алматы), но НИКОГДА
    не в отображении — `refresh_name_i18n` такие строки не читает.

    `is_colloquial`/`is_short` — GeoNames `isColloquial`/`isShort` (ADR-183,
    найдено на живых данных прода: «Ставропольский край» показывался
    разговорным «Ставрополье» — GeoNames метит такое имя `isPreferred=1,
    isShort=1`, а `isColloquial` при этом РАВЕН 0 — то есть одного
    `isColloquial`, изначально считавшегося причиной, для починки НЕ
    хватает, нужен ещё `isShort`). Как и `is_historic`, оба флага участвуют
    в ПОИСКЕ («Ставрополье» обязано находить Ставропольский край). В
    ОТОБРАЖЕНИИ — `refresh_name_i18n` (`services._names_by_locale_with_
    fallback`) исключает `is_colloquial=True` И `is_short=True` в ПЕРВУЮ
    очередь (полная форма побеждает), но, В ОТЛИЧИЕ от `is_historic`, НЕ
    абсолютно: если для локали у объекта вообще нет ни одного кандидата
    без этих флагов — разговорное/короткое имя показывается как фолбэк
    (пример с живых данных: Мурманск — сам источник метит действующее имя
    «Мурманск» `isShort=1, isColloquial=1`, полной формы попросту нет,
    только исторические и прозвища вроде «столица Заполярья» — латинский
    фолбэк на `City.name` был бы хуже)."""

    region = models.ForeignKey(Region, on_delete=models.CASCADE, related_name="alt_names")
    # locale — код БЕЗ диакритики/кириллицы (BCP-47, ASCII), "C" здесь не
    # проблема. name — НАСТОЯЩЕЕ название (кириллица/армянский/т.п. с
    # заглавной буквы — норма) БЕЗ явной коллации (докстринг модуля выше —
    # почему НЕ "C").
    locale = models.CharField(max_length=16, db_collation=_SEARCH_COLLATION)
    name = models.CharField(max_length=200)
    is_preferred = models.BooleanField(default=False)
    is_historic = models.BooleanField(default=False)
    is_colloquial = models.BooleanField(default=False)
    is_short = models.BooleanField(default=False)
    geonames_alt_name_id = models.PositiveBigIntegerField(unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "geo_region_name"
        verbose_name = "название региона"
        verbose_name_plural = "названия регионов"
        indexes = [
            models.Index(
                OpClass(Lower("name"), name="text_pattern_ops"),
                name="geo_region_alt_name_lower_idx",
            ),
            # Основной запрос при пересчёте name_i18n (services.
            # refresh_name_i18n) — DISTINCT ON (region_id) ... WHERE
            # locale=%s AND is_historic=False AND is_colloquial=False AND
            # is_short=False ORDER BY region_id, -is_preferred, [is_ascii_only
            # для нелатинописьменных локалей — не покрыт индексом, сравнивает
            # единицы строк внутри уже отфильтрованной группы, ADR-183], id:
            # индекс покрывает фильтр и главную часть сортировки.
            models.Index(
                fields=[
                    "locale",
                    "is_historic",
                    "is_colloquial",
                    "is_short",
                    "region",
                    "-is_preferred",
                    "id",
                ],
                name="geo_region_name_refresh_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.region_id}:{self.locale}={self.name}"


class CityName(models.Model):
    """Название города НА ОДНОМ ЯЗЫКЕ — см. `RegionName` (то же назначение,
    та же схема, тот же источник, зеркально для City; `is_colloquial`/
    `is_short` — там же, ADR-183)."""

    city = models.ForeignKey(City, on_delete=models.CASCADE, related_name="alt_names")
    # См. RegionName — то же (locale — ASCII-код, "C" ок; name — настоящее
    # название, без явной коллации).
    locale = models.CharField(max_length=16, db_collation=_SEARCH_COLLATION)
    name = models.CharField(max_length=200)
    is_preferred = models.BooleanField(default=False)
    is_historic = models.BooleanField(default=False)
    is_colloquial = models.BooleanField(default=False)
    is_short = models.BooleanField(default=False)
    geonames_alt_name_id = models.PositiveBigIntegerField(unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "geo_city_name"
        verbose_name = "название города"
        verbose_name_plural = "названия городов"
        indexes = [
            models.Index(
                OpClass(Lower("name"), name="text_pattern_ops"),
                name="geo_city_alt_name_lower_idx",
            ),
            models.Index(
                fields=[
                    "locale",
                    "is_historic",
                    "is_colloquial",
                    "is_short",
                    "city",
                    "-is_preferred",
                    "id",
                ],
                name="geo_city_name_refresh_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.city_id}:{self.locale}={self.name}"
