# apps.geo

Нижний слой (как `apps.catalog`/`apps.jurisdictions`/`apps.l10n`): не
импортирует ничего из других `apps.*` (import-linter). Справочник географии
для фильтра поиска — план 11.09 §2, ADR-179.

`Country` (код ISO 3166-1 alpha-2 как PK, названий не хранит — фронт
локализует код через `Intl.DisplayNames`) → `Region` (код источника
GeoNames, уникален в паре со страной — НЕ настоящий ISO 3166-2, см. ADR-179)
→ `City` (от 15 000 жителей, `geonames_id` уникален, координат не хранит).
`name`/`name_latin` — как дал источник; `name_i18n` (JSONField) —
предвычисленный на импорте кэш «лучшее имя на языке зрителя» (план 11.09
§2b, ADR-181; заполняется из `CityName`/`RegionName`, см. ниже).

Данные заполняются командой импорта, НЕ руками и НЕ сигналами:

```
python manage.py import_geo --download --countries=RU,KZ,BY,...
python manage.py import_geo --dir /path/to/geonames-dump  # уже скачанные файлы
python manage.py import_geo --dir ... --countries=all      # без ограничения по странам
python manage.py import_geo --download --skip-names        # без подушевых имён (только ADR-179)
python manage.py import_geo --names-only --download         # только имена поверх уже импортированного справочника (ADR-183)
```

Источник — GeoNames (`https://download.geonames.org/export/dump/`:
`countryInfo.txt`, `admin1CodesASCII.txt`, `cities15000.zip`, и, если не
передан `--skip-names`, `alternatenames/<CC>.zip` по одному архиву на
страну), лицензия CC BY 4.0 (атрибуция — ADR-179). Список стран по
умолчанию — `apps.geo.constants.DEFAULT_COUNTRY_CODES` (68 кодов,
синхронизирован вручную с
`web/src/features/groups/groupLabels.ts::COUNTRY_CODES`). Импорт
идемпотентен (`bulk_create(..., update_conflicts=True)` по
`geonames_id`/`code`/`geonames_alt_name_id`), потоковый (файлы читаются
построчно, `apps.geo.geonames`), битые строки — пропускаются со счётчиком,
не валят прогон.

**Названия на разных языках** (план 11.09 §2b, ADR-181): `CityName`/
`RegionName` — по одной строке на (объект, локаль) из подушевых файлов
GeoNames alternatenames, с флагами `is_preferred` (предпочитаемое имя
локали), `is_historic`, `is_colloquial`, `is_short` (последние три — ADR-183).
Все четыре участвуют в ПОИСКЕ («Алма-Ата» находит Алматы, «Ставрополье» —
Ставропольский край), но в `name_i18n` выбираются по фолбэк-иерархии
(`services._names_by_locale_with_fallback`, ADR-183): сначала ПОЛНАЯ форма
(без `is_historic`/`is_colloquial`/`is_short`) — среди неё `is_preferred`,
затем (для локалей с нелатинским письмом, `constants.LOCALE_SCRIPT_RANGES`)
кандидат с символом родной письменности, затем `id`; если для локали у
объекта НЕТ ни одного кандидата полной формы — фолбэк на короткое/
разговорное имя (лучше, чем латиница); историческое — НИКОГДА, даже как
последний фолбэк. Выбранный текст ещё проходит `constants.
normalize_generic_terms` (ADR-183, доп. 12.09) — GeoNames отдаёт родовые
слова регионов в Title Case («Ставропольский Край»), для локалей из
`constants.GENERIC_TERM_LOWERCASE` (сейчас только `ru`) они приводятся к
строчным, КРОМЕ случая, когда слово — первое в названии («Республика» в
список не входит — капитализируется в любой позиции, «Республика Адыгея»
И «Чеченская Республика» — обе верно с заглавной). Нормализация — только
для отображения, сырые `CityName.name`/`RegionName.name` (и поиск по ним)
не меняются. Сопоставление «наша локаль → код языка GeoNames» —
`apps.geo.constants.LOCALE_TO_GEONAMES_LANGS` (29 локалей `l10n/packs/*.json`,
явная таблица — `apps.geo` не импортирует `apps.l10n`).

**Аудит покрытия** — `manage.py geo_name_audit --locale=ru --countries=RU,KZ
--limit=50` (ADR-183, только чтение): по каждой стране — сколько
регионов/городов остаются латиницей (имени локали нет вовсе) и сколько
показываются коротким/разговорным именем (фолбэк), плюс примеры. Регионы —
первыми в выводе.

`apps/geo/tests/data/*_sample.txt` (включая `alternatenames_sample.txt`) —
маленькая фикстура для тестов (реальные строки источника, не выдуманные);
полный дамп в git не кладётся.

API (`api/urls.py`, доступ — авторизованный пользователь):

- `GET /v1/geo/countries` — активные страны справочника;
- `GET /v1/geo/regions?country=&q=&limit=` — регионы, префиксный поиск
  (оригинал/латиница/любой из наших языков, включая исторические имена,
  регистронезависимо), `code` в ответе — составной (`<страна>-<код>`,
  самодостаточен для фильтра городов), `display_name` — название на языке
  зрителя (локаль запроса, `common.i18n.resolve_request_locale`);
- `GET /v1/geo/cities?country=&region=&q=&limit=&cursor=` — города,
  «сначала крупные» (по населению), keyset-пагинация, лимит по умолчанию
  20 / максимум 50 (превышение — 400); `display_name` — как у регионов.

`selectors.py` — вся логика фильтров/поиска/пагинации; `services.py` —
логика импорта (вызывается из `management/commands/import_geo.py`, тонкой
CLI-обёртки). Привязка `apps.profiles.Profile` к City/Region и сам фильтр
поиска (`apps.dashboards`) — отдельные части плана, не здесь.

Ни от кого не зависит (import-linter).
