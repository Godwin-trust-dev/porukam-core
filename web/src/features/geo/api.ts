import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { GeoCity, GeoCityPage, GeoCountry, GeoRegion } from '@porukam/core';
import { api } from '../../shared/api';
import { countryName } from '../groups/groupLabels';

/**
 * Справочник `apps.geo` (план 11.09 §4, ADR-181/ADR-182) — ДВА потребителя:
 * редактор регионов работы профиля (`features/profile/WorkAreaPickerSheet.tsx`)
 * и гео-фильтр каталога поиска (`features/search/GeoFilterSheet.tsx`, ADR-194).
 * Тот же приём, что `useSpheres` (`features/contractNew/api.ts`):
 * `keepPreviousData`, чтобы список не моргал пустым между нажатиями клавиш.
 *
 * Сортировка по алфавиту ЗРИТЕЛЯ (ADR-194, замечание владельца 18.09:
 * «страны/регионы/города не отсортированы по алфавиту») — ОБЩАЯ для обоих
 * потребителей, поэтому живёт здесь, в хуках, а не в вызывающих компонентах:
 * иначе один пикер отсортирован, другой — нет, два разных порядка одного и
 * того же справочника. Коллатор — `Intl.Collator(i18n.language)`, создаётся
 * один раз на смену языка (`useMemo`), а не на каждый элемент списка.
 * Страны/регионы/города сортируются по ПОКАЗЫВАЕМОМУ имени: `countryName`
 * (страна — имени в БД нет вовсе, см. `GeoCountry`) и `display_name`
 * (регион/город — уже на языке зрителя, резолвит бэк).
 */

/** Страны — короткий список без поиска (бэк `q` не принимает вовсе, ADR-182:
 * имён в БД нет, локализует фронт `Intl.DisplayNames`); грузится один раз,
 * фильтр по локализованному имени — на клиенте (`useGeoCountries`). */
export function useGeoCountries() {
  const { i18n } = useTranslation();
  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  return useQuery({
    queryKey: ['geo-countries'],
    queryFn: () => api.request<GeoCountry[]>('/geo/countries'),
    staleTime: Infinity,
    select: (countries) =>
      [...countries].sort((a, b) => collator.compare(countryName(a.code, i18n.language), countryName(b.code, i18n.language))),
  });
}

/** `REGION_LIMIT_MAX` бэка (`apps.geo.selectors`) — без явного `limit` бэк
 * отдаёт дефолтных 50, а у одной только России 83 региона: 33 из них были
 * бы недостижимы (замечание владельца 18.09). */
const REGION_LIMIT_MAX = 200;

/** `CITY_LIMIT_MAX` бэка — дефолт 20 слишком мало даже для «алфавита среди
 * крупнейших» (решение владельца 18.09), запрашиваем сразу максимум. */
const CITY_LIMIT_MAX = 50;

/** Регионы/области — префиксный поиск на любом из наших языков (сервер,
 * ADR-181); `country` сужает выдачу, не обязателен. */
export function useGeoRegions(country: string | undefined, q: string) {
  const { i18n } = useTranslation();
  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  return useQuery({
    queryKey: ['geo-regions', country, q],
    enabled: Boolean(country),
    placeholderData: keepPreviousData,
    queryFn: () => api.request<GeoRegion[]>('/geo/regions', { query: { country, q: q || undefined, limit: REGION_LIMIT_MAX } }),
    select: (regions) => [...regions].sort((a, b) => collator.compare(a.display_name, b.display_name)),
  });
}

/** Города — сервер отдаёт «сначала крупные» (`limit` — потолок по
 * населению, не порядок показа), сортируем по алфавиту зрителя уже здесь:
 * решение владельца 18.09 «алфавит среди 50 крупнейших», а не порядок
 * населения на экране. `region` — составной код из `useGeoRegions`
 * (`KZ-02`); без него — поиск по всей стране; без ОБОИХ (`country`/`region`)
 * — глобальный поиск по названию (ADR-194, «ввёл город — подставился
 * регион»), но ТОЛЬКО пока есть непустой `q` — без него звать бэк не за
 * чем (список без страны и без текста не имеет смысла показывать). */
export function useGeoCities(country: string | undefined, region: string | undefined, q: string) {
  const { i18n } = useTranslation();
  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  const trimmedQ = q.trim();
  return useQuery({
    queryKey: ['geo-cities', country, region, q],
    enabled: Boolean(country) || trimmedQ.length > 0,
    placeholderData: keepPreviousData,
    queryFn: () =>
      api
        .request<GeoCityPage>('/geo/cities', { query: { country, region, q: q || undefined, limit: CITY_LIMIT_MAX } })
        .then((page) => page.items),
    select: (cities) => [...cities].sort((a, b) => collator.compare(a.display_name, b.display_name)),
  });
}

/** Локальный фильтр `/v1/geo/countries` по локализованному имени —
 * сервер `q` не поддерживает (см. `useGeoCountries`), а список короткий
 * (активные страны справочника, не все ISO 3166-1). Порядок входного списка
 * сохраняется (`Array.filter`) — сортировка уже сделана `useGeoCountries`. */
export function filterCountries(countries: GeoCountry[], q: string, countryName: (code: string) => string): GeoCountry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return countries;
  return countries.filter(
    (c) => countryName(c.code).toLowerCase().startsWith(needle) || c.code.toLowerCase().startsWith(needle),
  );
}

export type { GeoCity };
