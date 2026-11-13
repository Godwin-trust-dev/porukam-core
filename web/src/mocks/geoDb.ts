/**
 * Мок-справочник `apps.geo` (план 11.09 §4, ADR-181/ADR-182) — небольшой,
 * но той же формы, что реальный: страны без имён (`GeoCountry.code`),
 * регионы/города с `name`/`name_latin`/`name_i18n`/`display_name`.
 * Потребители — редактор регионов работы (`features/profile/
 * WorkAreaPickerSheet.tsx`) и гео-фильтр каталога поиска
 * (`features/search/GeoFilterSheet.tsx`, ADR-194) через `geoHandlers.ts`.
 * `searchCities` без `country` и `region` — глобальный поиск по названию
 * (ADR-194, «ввёл город — подставился регион»): фильтрует ВЕСЬ мок-датасет,
 * не только одну страну — то же, что делает бэк без параметра `country`.
 *
 * Порог «от 15 000 жителей» (ADR-179) воспроизведён буквально: в датасете
 * НЕТ городов меньше него — поиск маленького посёлка (например «Дно» или
 * вымышленного «Малые Вязы») намеренно возвращает пусто, это и проверяет
 * подсказку «не нашли — укажите регион/страну» (план 11.09 §4 п.5).
 */
import type { GeoCity, GeoCountry, GeoRegion } from '@porukam/core';

/** Сырые записи — БЕЗ `display_name` (тот считается НА ЗАПРОС по локали
 * зрителя, `displayNameFor` ниже, — как на бэке, `_display_name` не хранится
 * в БД). У города — ещё и без `region_name` (ADR-194, ветка бэка
 * `feat/geo-city-region`): тоже считается на запрос, из региона того же
 * города (`withCityDisplay` ниже), а не хранится сырым полем. */
type RawRegion = Omit<GeoRegion, 'display_name'>;
type RawCity = Omit<GeoCity, 'display_name' | 'region_name'>;

export const MOCK_COUNTRIES: GeoCountry[] = [
  { code: 'RU' },
  { code: 'KZ' },
  { code: 'US' },
  { code: 'DE' },
];

const RAW_REGIONS: RawRegion[] = [
  {
    code: 'RU-MOS',
    country: 'RU',
    name: 'Московская область',
    name_latin: 'Moskovskaya oblast',
    name_i18n: { ru: 'Московская область', en: 'Moscow region' },
  },
  {
    code: 'RU-LEN',
    country: 'RU',
    name: 'Ленинградская область',
    name_latin: 'Leningradskaya oblast',
    name_i18n: { ru: 'Ленинградская область', en: 'Leningrad region' },
  },
  {
    code: 'KZ-ALM',
    country: 'KZ',
    name: 'Алматинская область',
    name_latin: 'Almatinskaya oblast',
    name_i18n: { ru: 'Алматинская область', en: 'Almaty region', kk: 'Алматы облысы' },
  },
  {
    code: 'US-CA',
    country: 'US',
    name: 'California',
    name_latin: 'California',
    name_i18n: { en: 'California', ru: 'Калифорния' },
  },
  {
    code: 'DE-BE',
    country: 'DE',
    name: 'Berlin',
    name_latin: 'Berlin',
    name_i18n: { en: 'Berlin', ru: 'Берлин', de: 'Berlin' },
  },
];

const RAW_CITIES: RawCity[] = [
  {
    id: 1,
    country: 'RU',
    region: 'RU-MOS',
    name: 'Москва',
    name_latin: 'Moskva',
    name_i18n: { ru: 'Москва', en: 'Moscow' },
    population: 12_600_000,
  },
  {
    id: 2,
    country: 'RU',
    region: 'RU-LEN',
    name: 'Санкт-Петербург',
    name_latin: 'Sankt-Peterburg',
    name_i18n: { ru: 'Санкт-Петербург', en: 'Saint Petersburg' },
    population: 5_400_000,
  },
  {
    id: 3,
    country: 'KZ',
    region: 'KZ-ALM',
    name: 'Алматы',
    name_latin: 'Almaty',
    // Историческое имя (ADR-181) — «Алма-Ата» находит тот же город.
    name_i18n: { ru: 'Алматы', en: 'Almaty', kk: 'Алматы' },
    population: 2_000_000,
  },
  {
    id: 4,
    country: 'US',
    region: 'US-CA',
    name: 'Los Angeles',
    name_latin: 'Los Angeles',
    name_i18n: { en: 'Los Angeles', ru: 'Лос-Анджелес' },
    population: 3_900_000,
  },
  {
    id: 5,
    country: 'DE',
    region: 'DE-BE',
    name: 'Berlin',
    name_latin: 'Berlin',
    name_i18n: { en: 'Berlin', ru: 'Берлин', de: 'Berlin' },
    population: 3_600_000,
  },
];

/** Название на языке зрителя — зеркало `apps.geo.api.serializers._display_name`:
 * `name_i18n[locale]` → `name` → `name_latin`. `locale` — полный код (ровно
 * то, что `Accept-Language` несёт от `ApiClient.getLocale()` — активный
 * `i18n.language`, БЕЗ огрубления до примарной подгруппы: `pt-BR`/`zh-Hans`
 * должны матчиться как есть, см. ADR-079). */
export function displayNameFor(item: { name: string; name_latin: string; name_i18n: Record<string, string> }, locale: string): string {
  return item.name_i18n[locale] || item.name || item.name_latin;
}

function withRegionDisplay(region: RawRegion, locale: string): GeoRegion {
  return { ...region, display_name: displayNameFor(region, locale) };
}

function withCityDisplay(city: RawCity, locale: string): GeoCity {
  // `getRegion` — объявление функции (hoisting), можно звать до её
  // текстового определения ниже по файлу.
  const region = city.region ? getRegion(city.region, locale) : undefined;
  return { ...city, display_name: displayNameFor(city, locale), region_name: region?.display_name ?? null };
}

function startsWith(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().startsWith(needle.toLowerCase());
}

/** Префиксный поиск по имени НА ЛЮБОМ языке (исходное/латиница/любая
 * локаль `name_i18n`) — зеркало `apps.geo.selectors.search_regions`. */
export function searchRegions(country: string | null, q: string | null, locale: string): GeoRegion[] {
  let rows = RAW_REGIONS;
  if (country) rows = rows.filter((r) => r.country === country.toUpperCase());
  if (q?.trim()) {
    const needle = q.trim();
    rows = rows.filter(
      (r) => startsWith(r.name, needle) || startsWith(r.name_latin, needle) || Object.values(r.name_i18n).some((n) => startsWith(n, needle)),
    );
  }
  return rows.map((r) => withRegionDisplay(r, locale));
}

/** Зеркало `apps.geo.selectors.list_cities` — без keyset-пагинации (мок-датасет
 * умещается в одну страницу целиком), «сначала крупные». */
export function searchCities(country: string | null, region: string | null, q: string | null, locale: string): GeoCity[] {
  let rows = RAW_CITIES;
  if (region) rows = rows.filter((c) => c.region === region);
  else if (country) rows = rows.filter((c) => c.country === country.toUpperCase());
  if (q?.trim()) {
    const needle = q.trim();
    rows = rows.filter(
      (c) => startsWith(c.name, needle) || startsWith(c.name_latin, needle) || Object.values(c.name_i18n).some((n) => startsWith(n, needle)),
    );
  }
  return [...rows].sort((a, b) => b.population - a.population).map((c) => withCityDisplay(c, locale));
}

export function getCountry(code: string): GeoCountry | undefined {
  return MOCK_COUNTRIES.find((c) => c.code === code.toUpperCase());
}

export function getRegion(code: string, locale: string): GeoRegion | undefined {
  const raw = RAW_REGIONS.find((r) => r.code === code);
  return raw ? withRegionDisplay(raw, locale) : undefined;
}

export function getCity(id: number, locale: string): GeoCity | undefined {
  const raw = RAW_CITIES.find((c) => c.id === id);
  return raw ? withCityDisplay(raw, locale) : undefined;
}
