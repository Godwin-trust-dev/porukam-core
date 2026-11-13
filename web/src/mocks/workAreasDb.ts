/**
 * Мок-стор `apps.profiles.WorkArea` (план 11.09 §4, ADR-182) — регионы
 * работы профиля. Реестр по `profileId`, полная замена при `PUT` — то же
 * поведение, что `services.replace_work_areas` (идемпотентно, ≤ 5 записей,
 * дублей нет, ссылка на `apps.geo` обязана существовать и быть внутренне
 * согласованной).
 */
import type { GeoCountry, WorkArea, WorkAreaScope, WorkAreaWriteItem } from '@porukam/core';
import { getCity, getCountry, getRegion } from './geoDb';

export const WORK_AREA_MAX = 5;

export class WorkAreaLimitError extends Error {}
export class WorkAreaDuplicateError extends Error {}
export class WorkAreaLocationMismatchError extends Error {}
export class WorkAreaUnknownLocationError extends Error {}
export class WorkAreaInvalidPayloadError extends Error {}

const registry = new Map<string, WorkArea[]>();
let seq = 1;

function resolveLocation(item: WorkAreaWriteItem, locale: string): WorkArea['location'] {
  switch (item.scope) {
    case 'world':
      if (item.country || item.region || item.city) {
        throw new WorkAreaInvalidPayloadError('scope=world не принимает country/region/city');
      }
      return null;
    case 'country': {
      if (!item.country || item.region || item.city) throw new WorkAreaInvalidPayloadError('scope=country требует ровно country');
      const country = getCountry(item.country);
      if (!country) throw new WorkAreaUnknownLocationError(`страна не найдена: ${item.country}`);
      return country satisfies GeoCountry;
    }
    case 'region': {
      if (!item.region || item.city) throw new WorkAreaInvalidPayloadError('scope=region требует region (city — нет)');
      const region = getRegion(item.region, locale);
      if (!region) throw new WorkAreaUnknownLocationError(`регион не найден: ${item.region}`);
      if (item.country && item.country.toUpperCase() !== region.country) {
        throw new WorkAreaLocationMismatchError('регион не принадлежит указанной стране');
      }
      return region;
    }
    case 'city': {
      if (!item.city) throw new WorkAreaInvalidPayloadError('scope=city требует city');
      const city = getCity(item.city, locale);
      if (!city) throw new WorkAreaUnknownLocationError(`город не найден: ${item.city}`);
      if (item.region && item.region !== city.region) {
        throw new WorkAreaLocationMismatchError('город не принадлежит указанному региону');
      }
      if (item.country && item.country.toUpperCase() !== city.country) {
        throw new WorkAreaLocationMismatchError('город не принадлежит указанной стране');
      }
      return city;
    }
    default:
      throw new WorkAreaInvalidPayloadError(`неизвестный масштаб: ${String(item.scope)}`);
  }
}

/** Ключ дедупликации ВНУТРИ одного запроса — зеркало `_resolve_work_area_item`
 * бэка (`(scope, country_id, region_id, city_id)`). */
function dedupeKey(scope: WorkAreaScope, location: WorkArea['location']): string {
  if (scope === 'world') return 'world';
  if (scope === 'country') return `country:${(location as GeoCountry).code}`;
  if (scope === 'region') return `region:${(location as { code: string }).code}`;
  return `city:${(location as { id: number }).id}`;
}

export function listWorkAreas(profileId: string): WorkArea[] {
  return registry.get(profileId) ?? [];
}

export function replaceWorkAreas(profileId: string, items: WorkAreaWriteItem[], locale: string): WorkArea[] {
  if (items.length > WORK_AREA_MAX) throw new WorkAreaLimitError(`не больше ${WORK_AREA_MAX} регионов работы`);

  const seen = new Set<string>();
  const resolved: WorkArea[] = [];
  for (const item of items) {
    const location = resolveLocation(item, locale);
    const key = dedupeKey(item.scope, location);
    if (seen.has(key)) throw new WorkAreaDuplicateError(`место указано дважды: ${key}`);
    seen.add(key);
    seq += 1;
    resolved.push({ id: `wa-mock-${seq}`, scope: item.scope, location, created_at: new Date().toISOString() });
  }
  registry.set(profileId, resolved);
  return resolved;
}

export function resetWorkAreasDb(): void {
  registry.clear();
  seq = 1;
}
