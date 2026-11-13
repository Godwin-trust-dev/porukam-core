import { useGeoCities, useGeoRegions } from '../geo/api';
import { countryName } from '../groups/groupLabels';

/**
 * Гео-фильтр каталога (план 11.09 §6, ADR-184/185) — РОВНО параметры бэка
 * (`country`/`region`/`city` `GET /dashboard/search`): на любом ОДНОМ
 * уровне, `null` везде — «весь мир», без единого исключения. Каскад
 * (`GeoFilterSheet`) сам держит поля согласованными при выборе (страна
 * региона/города совпадает); отдельного «scope» не нужно — глубина фильтра
 * это просто самое глубокое непустое поле, как и решает сам бэк при
 * рассогласованном вводе (ADR-184 «побеждает самый глубокий»).
 */
export interface GeoFilter {
  country: string | null;
  region: string | null;
  city: number | null;
}

export const WORLD_GEO_FILTER: GeoFilter = { country: null, region: null, city: null };

export function geoFilterActive(filter: GeoFilter): boolean {
  return filter.country != null;
}

/**
 * Гео-фильтр на ОДИН уровень ШИРЕ — снимает самое глубокое непустое поле
 * (город → регион, регион → страна, страна → весь мир). Ровно то действие,
 * которое предлагает пустая выдача каталога, сузившаяся геолокацией (план
 * 11.09 §7, ADR-187): одна кнопка «искать шире», а не сброс всех фильтров.
 * На уже мировом фильтре — no-op (звать имеет смысл только под
 * `geoFilterActive`).
 */
export function widenGeoFilter(filter: GeoFilter): GeoFilter {
  if (filter.city != null) return { country: filter.country, region: filter.region, city: null };
  if (filter.region != null) return { country: filter.country, region: null, city: null };
  return WORLD_GEO_FILTER;
}

/**
 * Подпись текущего гео-фильтра для кнопки-триггера панели («Алматы,
 * Казахстан» / «Весь мир») — резолвит `display_name` региона/города из
 * справочника `apps.geo`. Те же хуки (`useGeoRegions`/`useGeoCities`),
 * что использует сам `GeoFilterSheet` при выборе — react-query отдаёт
 * значение из общего кэша по совпадающему ключу запроса, второго похода в
 * сеть на один и тот же список нет. Пока список ещё не пришёл (первое
 * открытие страницы по прямой ссылке с `?city=`) — временно показываем
 * название страны, без мигания пустой строкой.
 */
export function useGeoFilterLabel(filter: GeoFilter, lang: string, worldLabel: string): string {
  const { data: regions } = useGeoRegions(filter.country ?? undefined, '');
  const { data: cities } = useGeoCities(filter.country ?? undefined, filter.region ?? undefined, '');
  if (!filter.country) return worldLabel;
  const country = countryName(filter.country, lang);
  if (filter.city != null) {
    const city = cities?.find((c) => c.id === filter.city);
    return city ? `${city.display_name}, ${country}` : country;
  }
  if (filter.region) {
    const region = regions?.find((r) => r.code === filter.region);
    return region ? `${region.display_name}, ${country}` : country;
  }
  return country;
}
