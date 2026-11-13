/**
 * Справочник `apps.geo` (план 11.09 §4, ADR-181/ADR-182) + регионы работы
 * профиля (`apps.profiles.WorkArea`, ADR-182).
 *
 * `display_name` — название НА ЯЗЫКЕ ЗРИТЕЛЯ, сервер уже резолвит локаль
 * (`common.i18n.resolve_request_locale`) — фронт просто показывает строку,
 * ничего не переводит сам. Исключение — страна: `GeoCountry` несёт только
 * `code` (в БД `apps.geo.Country` имён нет вовсе), имя строит сам фронт
 * через `Intl.DisplayNames` (`countryName` из `features/groups/groupLabels`).
 */

/** `GET /v1/geo/countries` — активная страна справочника, без имени. */
export interface GeoCountry {
  code: string;
}

/** `GET /v1/geo/regions` — регион/область; `code` — составной (`<страна>-<код>`),
 * им же фильтруются `/v1/geo/cities?region=`. */
export interface GeoRegion {
  code: string;
  country: string;
  name: string;
  name_latin: string;
  name_i18n: Record<string, string>;
  display_name: string;
}

/** `GET /v1/geo/cities` — город; `region` — составной код региона, `null` —
 * города без известного региона в источнике. `region_name` — имя региона НА
 * ЯЗЫКЕ ЗРИТЕЛЯ (ветка бэка `feat/geo-city-region`, план 18.09 «ввёл город —
 * подставился регион»): `null`, когда `region` тоже `null`. Используется
 * глобальным полем поиска города (`GeoFilterSheet`, шаг «Страна») — показать,
 * что подставится, до выбора. */
export interface GeoCity {
  id: number;
  country: string;
  region: string | null;
  region_name: string | null;
  name: string;
  name_latin: string;
  name_i18n: Record<string, string>;
  display_name: string;
  population: number;
}

/** `GET /v1/geo/cities` — страница (keyset-пагинация по населению). */
export interface GeoCityPage {
  items: GeoCity[];
  next_cursor: string | null;
}

/** Масштаб региона работы (`apps.profiles.WorkArea.Scope`, ADR-182) — от
 * «весь мир» до конкретного города; житель посёлка, которого нет в
 * справочнике (порог 15 000 жителей, ADR-179), указывает себя КРУПНЕЕ. */
export type WorkAreaScope = 'world' | 'country' | 'region' | 'city';

/** `GET`/`PUT /v1/profiles/{id}/work-areas` — одна запись региона работы.
 * `location` — `null` для `scope: 'world'`; для `'country'` — `GeoCountry`
 * (только код, имя строит фронт); для `'region'`/`'city'` — тот же объект,
 * что отдают `/v1/geo/regions`/`/v1/geo/cities` (уже с `display_name`). */
export interface WorkArea {
  id: string;
  scope: WorkAreaScope;
  location: GeoCountry | GeoRegion | GeoCity | null;
  created_at: string;
}

/** Тело `PUT /v1/profiles/{id}/work-areas` — один элемент. `country` — ISO
 * 3166-1 alpha-2, `region` — составной код из `/v1/geo/regions` (`KZ-02`),
 * `city` — id из `/v1/geo/cities`. Поля, лишние для `scope`, не отправляются. */
export interface WorkAreaWriteItem {
  scope: WorkAreaScope;
  country?: string;
  region?: string;
  city?: number;
}

/**
 * Регион работы в КАТАЛОЖНОЙ выдаче поиска (план 11.09 §6, `catalog` в
 * `GET /v1/dashboard/search`, ADR-184/185) — НЕ то же самое, что `WorkArea`
 * выше: сервер отдаёт независимую минимальную копию полей
 * (`CatalogWorkAreaSerializer`, ADR-184 «Пределы задачи» — api-слой
 * `apps.dashboards` не импортирует чужой сериализатор). После приёмки 12.09
 * (`26abc882`) форма СОВПАДАЕТ с `/v1/profiles/{id}/work-areas` (ADR-182) и
 * `apps.geo.api.serializers` — страна тем же ключом `code`, что и везде
 * (было расхождение `country` vs `code`, исправлено на бэке). Единственное
 * оставшееся отличие от `GeoRegion`/`GeoCity` — здесь НЕТ `name`/`name_latin`/
 * `name_i18n`, только `display_name` (уже на языке зрителя).
 */
export interface CatalogWorkAreaLocation {
  /** Есть только у scope: 'region' (составной код `KZ-02`) — ключ страны у
   * scope: 'country' называется так же, `code`, но несёт alpha-2. */
  code?: string;
  /** Alpha-2 страны — есть у country (как `code`), region и city (как `country`). */
  country?: string;
  /** Составной код региона города или `null` — есть только у scope: 'city'. */
  region?: string | null;
  /** id города — есть только у scope: 'city'. */
  id?: number;
  /** Есть у region/city — уже на языке зрителя. */
  display_name?: string;
  /** Есть только у scope: 'city'. */
  population?: number;
}

/** `location: null` — для `scope: 'world'` (показывать нечего). */
export interface CatalogWorkArea {
  scope: WorkAreaScope;
  location: CatalogWorkAreaLocation | null;
}

/** Строка каталожной выдачи `GET /v1/dashboard/search` (`catalog.items[]`,
 * план 11.09 §6, ADR-184) — исполнитель, подошедший под фильтры гео/сфер/
 * опыта. `completed_deals_count` — «опыт», завершённые сделки ИМЕННО
 * исполнителем (`apps.reputation`), не карточка репутации целиком.
 *
 * `geo_match` (ADR-194, бэк-ветка параллельной задачи 18.09) — «местный»
 * (`'local'`, попадает в заданное гео-место буквально) или «работает
 * удалённо» (`'remote'`, заявлен `scope: 'world'`, совпал под ЛЮБОЙ гео-
 * фильтр); `null` — гео-фильтр не задан, деления на два блока нет. Поле
 * НЕОБЯЗАТЕЛЬНОЕ — бэк добавляет его в отдельной ветке, фронт не должен
 * падать до мержа (тогда просто `undefined`, `SearchPage` считает это
 * «фильтра нет»). */
export interface CatalogItem {
  profile_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  completed_deals_count: number;
  work_areas: CatalogWorkArea[];
  geo_match?: 'local' | 'remote' | null;
}

/** Страница каталога — keyset-пагинация, `next_cursor: null` на последней. */
export interface CatalogPage {
  items: CatalogItem[];
  next_cursor: string | null;
}
