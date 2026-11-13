import type { GeoCity, GeoCountry, GeoRegion, WorkArea, WorkAreaWriteItem } from '@porukam/core';
import { countryName } from '../groups/groupLabels';

/** Зеркало `apps.profiles.services.WORK_AREA_MAX` (план 11.09 §4, ADR-182) —
 * лимит проверяется и на клиенте (понятная подсказка ДО похода на сервер,
 * не 422 постфактум), и на сервере (реальный источник истины). */
export const WORK_AREA_MAX = 5;

/** Ключ дедупликации — та же логика, что `_resolve_work_area_item` бэка:
 * совпадение по (scope, ссылка на apps.geo). Используется и клиентской
 * проверкой дублей при добавлении, и мок-стором (`workAreasDb.ts`). */
export function workAreaKey(entry: Pick<WorkArea, 'scope' | 'location'>): string {
  switch (entry.scope) {
    case 'world':
      return 'world';
    case 'country':
      return `country:${(entry.location as GeoCountry).code}`;
    case 'region':
      return `region:${(entry.location as GeoRegion).code}`;
    case 'city':
      return `city:${(entry.location as GeoCity).id}`;
  }
}

/** Подпись чипа: «Весь мир» / название страны (локализует фронт, в БД имён
 * стран нет) / `display_name` региона-города (уже на языке зрителя,
 * `apps.geo.api.serializers._display_name`) — для города/региона рядом
 * добавляем страну через запятую (одноимённые регионы/города в разных
 * странах — не редкость). */
export function workAreaLabel(entry: Pick<WorkArea, 'scope' | 'location'>, lang: string, worldLabel: string): string {
  switch (entry.scope) {
    case 'world':
      return worldLabel;
    case 'country':
      return countryName((entry.location as GeoCountry).code, lang);
    case 'region': {
      const region = entry.location as GeoRegion;
      const country = countryName(region.country, lang);
      return country ? `${region.display_name}, ${country}` : region.display_name;
    }
    case 'city': {
      const city = entry.location as GeoCity;
      const country = countryName(city.country, lang);
      return country ? `${city.display_name}, ${country}` : city.display_name;
    }
  }
}

/** `WorkArea` (в т.ч. ещё не сохранённый, только что выбранный в пикере) →
 * тело `PUT /work-areas`. Обратное преобразование не нужно: `location`
 * уже несёт всё необходимое (страна/регион берутся из него же — те же
 * объекты `apps.geo`, что отдают `/v1/geo/regions`/`/v1/geo/cities`). */
export function toWriteItem(entry: Pick<WorkArea, 'scope' | 'location'>): WorkAreaWriteItem {
  switch (entry.scope) {
    case 'world':
      return { scope: 'world' };
    case 'country':
      return { scope: 'country', country: (entry.location as GeoCountry).code };
    case 'region': {
      const region = entry.location as GeoRegion;
      return { scope: 'region', country: region.country, region: region.code };
    }
    case 'city': {
      const city = entry.location as GeoCity;
      return { scope: 'city', country: city.country, region: city.region ?? undefined, city: city.id };
    }
  }
}

let tempSeq = 0;

/** id для ЕЩЁ НЕ сохранённой записи (до `PUT`, в редакторе) — стабилен в
 * рамках сессии редактирования, реальный id придёт с ответом `PUT`. */
export function tempWorkAreaId(): string {
  tempSeq += 1;
  return `new-${Date.now()}-${tempSeq}`;
}
