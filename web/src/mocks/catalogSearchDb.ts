/**
 * Мок каталожной ветки `catalog` в `GET /v1/dashboard/search` (план 11.09
 * §6, ADR-184/185) — небольшой in-memory датасет исполнителей поверх той же
 * гео-базы, что `geoDb.ts` (RU/KZ/US/DE), и тех же кодов сфер, что
 * `catalog.ts` (`spheres`). Правило покрытия (широкий масштаб покрывает
 * узкий) — упрощённое зеркало `apps.profiles.selectors.geo_filter_coverage_q`
 * (ADR-184): полная ветвинная проверка живёт в backend-тестах
 * (`test_catalog_search.py`), здесь только для правдоподобного мок-режима
 * и ручного просмотра `/search` без бэкенда.
 *
 * `geo_match` (ADR-194, бэк-ветка параллельной задачи 18.09) — `'local'`/
 * `'remote'`/`null`, см. `geoMatchFor` ниже: та же логика покрытия, что
 * `matchesGeo`, только различает СПОСОБ совпадения (конкретное место vs
 * заявленный `scope: 'world'`).
 */
import type { CatalogItem, CatalogPage, CatalogWorkArea, CatalogWorkAreaLocation, WorkAreaScope } from '@porukam/core';
import { getCity, getRegion } from './geoDb';

interface WorkAreaSeed {
  scope: WorkAreaScope;
  country?: string;
  region?: string;
  city?: number;
}

interface CatalogProfileSeed {
  profile_id: string;
  handle: string;
  display_name: string;
  completed_deals_count: number;
  spheres: string[];
  /** ADR-190/191 — заявленные виды работ, составные коды `<сфера>.<категория>`
   * (тот же формат, что `Profile.work_type_codes`/`?work_type=`). Не у всех
   * сидов — только там, где нужен правдоподобный сценарий для ручной
   * проверки/e2e фильтра по виду работ. */
  work_types?: string[];
  work_areas: WorkAreaSeed[];
}

/** Порядок — от новых к старым (тот же порядок, что `-created_at, -id`
 * реального keyset). Разные сферы/уровни гео/пороги опыта — чтобы каждый
 * фильтр из панели находил хоть кого-то. */
const SEEDS: CatalogProfileSeed[] = [
  {
    profile_id: 'pf-catalog-almaty-repair',
    handle: '@almaty_master',
    display_name: 'Ерлан Байтасов',
    completed_deals_count: 6,
    spheres: ['repair', 'finishing'],
    work_types: ['repair.repair_kitchen', 'finishing.finishing_tiling'],
    work_areas: [{ scope: 'city', city: 3 }], // Алматы
  },
  {
    profile_id: 'pf-catalog-almaty-cleaning',
    handle: '@clean_almaty',
    display_name: 'Гульнара Ахметова',
    completed_deals_count: 2,
    spheres: ['cleaning'],
    work_areas: [{ scope: 'city', city: 3 }], // Алматы
  },
  {
    profile_id: 'pf-catalog-kz-electrical',
    handle: '@kz_electric',
    display_name: 'Данияр Сериков',
    completed_deals_count: 4,
    spheres: ['electrical'],
    work_areas: [{ scope: 'country', country: 'KZ' }],
  },
  {
    profile_id: 'pf-catalog-moscow-furniture',
    handle: '@msk_furniture',
    display_name: 'Марат Отделкин',
    completed_deals_count: 12,
    spheres: ['furniture', 'repair'],
    work_types: ['furniture.furniture_wardrobe', 'repair.repair_kitchen'],
    work_areas: [{ scope: 'city', city: 1 }], // Москва
  },
  {
    profile_id: 'pf-catalog-mos-region-plumbing',
    handle: '@mos_plumb',
    display_name: 'Игорь Кузнецов',
    completed_deals_count: 0,
    spheres: ['plumbing'],
    work_areas: [{ scope: 'region', region: 'RU-MOS' }],
  },
  {
    profile_id: 'pf-catalog-spb-design',
    handle: '@spb_design',
    display_name: 'Анна Волкова',
    completed_deals_count: 3,
    spheres: ['design'],
    work_areas: [{ scope: 'city', city: 2 }], // Санкт-Петербург
  },
  {
    profile_id: 'pf-catalog-world-translation',
    handle: '@translator_world',
    display_name: 'Ли Вэй',
    completed_deals_count: 9,
    spheres: ['translation'],
    work_areas: [{ scope: 'world' }],
  },
  {
    profile_id: 'pf-catalog-de-moving',
    handle: '@berlin_moving',
    display_name: 'Hans Weber',
    completed_deals_count: 1,
    spheres: ['moving'],
    work_areas: [{ scope: 'city', city: 5 }], // Berlin
  },
];

function locationFor(wa: WorkAreaSeed, locale: string): CatalogWorkAreaLocation | null {
  switch (wa.scope) {
    case 'world':
      return null;
    case 'country':
      // Ключ `code`, а НЕ `country` — приёмка 12.09 (`26abc882`) выровняла
      // форму с `apps.geo`/`work-areas`, мок должен воспроизводить бэк.
      return { code: wa.country };
    case 'region': {
      const region = getRegion(wa.region ?? '', locale);
      return region ? { code: region.code, country: region.country, display_name: region.display_name } : null;
    }
    case 'city': {
      const city = getCity(wa.city ?? 0, locale);
      return city
        ? { id: city.id, country: city.country, region: city.region, display_name: city.display_name, population: city.population }
        : null;
    }
  }
}

function toCatalogWorkAreas(seed: CatalogProfileSeed, locale: string): CatalogWorkArea[] {
  return seed.work_areas.map((wa) => ({ scope: wa.scope, location: locationFor(wa, locale) }));
}

/** Целевая тройка (страна/регион/город) запроса — глубже заданный уровень
 * РЕЗОЛВИТ более мелкие (город несёт свой регион и страну), тот же приём,
 * что `apps.profiles.selectors.geo_filter_coverage_q` (Subquery на City/
 * Region вместо похода в Python за id, здесь — прямой словарный доступ). */
function resolveTarget(country: string | null, region: string | null, city: number | null): { country: string | null; region: string | null; city: number | null } {
  if (city != null) {
    const found = getCity(city, 'ru');
    return { country: found?.country ?? null, region: found?.region ?? null, city };
  }
  if (region) {
    const found = getRegion(region, 'ru');
    return { country: found?.country ?? null, region, city: null };
  }
  return { country: country ? country.toUpperCase() : null, region: null, city: null };
}

/** Совпадает ли ОДНА запись региона работы с целью запроса — вынесена из
 * `matchesGeo` (ADR-194): нужна отдельно, чтобы различить «местного»
 * (совпал НЕ через `scope: 'world'`) от «работает удалённо» (совпал только
 * потому, что заявил весь мир), см. `geoMatchFor` ниже. */
function matchesWorkArea(wa: WorkAreaSeed, target: { country: string | null; region: string | null; city: number | null }): boolean {
  if (wa.scope === 'world') return true;
  if (wa.scope === 'country') return wa.country === target.country;
  if (wa.scope === 'region') {
    const region = getRegion(wa.region ?? '', 'ru');
    if (!region || region.country !== target.country) return false;
    return target.region == null || target.region === wa.region;
  }
  // scope === 'city'
  const cityRow = getCity(wa.city ?? 0, 'ru');
  if (!cityRow || cityRow.country !== target.country) return false;
  if (target.region != null && cityRow.region !== target.region) return false;
  return target.city == null || target.city === wa.city;
}

function matchesGeo(seed: CatalogProfileSeed, target: { country: string | null; region: string | null; city: number | null }): boolean {
  if (!target.country) return true; // без фильтра — весь мир
  return seed.work_areas.some((wa) => matchesWorkArea(wa, target));
}

/** «Местный» / «работает удалённо» (ADR-194, план 18.09 «два блока выдачи
 * каталога») — `null`, когда гео-фильтр не задан (`SearchPage` в этом
 * случае вообще не делит выдачу на блоки). Местный — заявил КОНКРЕТНОЕ
 * место, совпавшее с целью (страна/регион/город, НЕ `scope: 'world'`);
 * `scope: 'world'` (совпадает с ЛЮБЫМ гео-фильтром) — «работает удалённо». */
function geoMatchFor(seed: CatalogProfileSeed, target: { country: string | null; region: string | null; city: number | null }): 'local' | 'remote' | null {
  if (!target.country) return null;
  const local = seed.work_areas.some((wa) => wa.scope !== 'world' && matchesWorkArea(wa, target));
  return local ? 'local' : 'remote';
}

function matchesSphere(seed: CatalogProfileSeed, sphereCodes: string[]): boolean {
  if (sphereCodes.length === 0) return true;
  return seed.spheres.some((code) => sphereCodes.includes(code));
}

/** ADR-190/191 — независимый фильтр по видам работ (составные коды), ИЛИ
 * между значениями, ровно как `matchesSphere` (тот же приём бэка,
 * `apps.profiles.selectors.declared_work_type_q`). */
function matchesWorkType(seed: CatalogProfileSeed, workTypeCodes: string[]): boolean {
  if (workTypeCodes.length === 0) return true;
  return (seed.work_types ?? []).some((code) => workTypeCodes.includes(code));
}

export interface CatalogFilterParams {
  country: string | null;
  region: string | null;
  city: number | null;
  sphereCodes: string[];
  workTypeCodes: string[];
  minExperience: number | null;
  limit: number;
  cursor: string | null;
  locale: string;
}

/** Курсор мок-каталога — просто индекс следующей строки (датасет статичен и
 * мал, реальному base64(dataclass|id) он подражать не обязан — контракт
 * фронта тот же: непрозрачная строка, `null` на последней странице). */
export function getSearchCatalogPage(params: CatalogFilterParams): CatalogPage {
  const target = resolveTarget(params.country, params.region, params.city);
  const filtered = SEEDS.filter(
    (seed) =>
      matchesGeo(seed, target) &&
      matchesSphere(seed, params.sphereCodes) &&
      matchesWorkType(seed, params.workTypeCodes) &&
      (params.minExperience == null || seed.completed_deals_count >= params.minExperience),
  );

  const start = params.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
  const page = filtered.slice(start, start + params.limit);
  const nextIndex = start + page.length;

  const items: CatalogItem[] = page.map((seed) => ({
    profile_id: seed.profile_id,
    handle: seed.handle,
    display_name: seed.display_name,
    avatar_url: null,
    completed_deals_count: seed.completed_deals_count,
    work_areas: toCatalogWorkAreas(seed, params.locale),
    geo_match: geoMatchFor(seed, target),
  }));

  return { items, next_cursor: nextIndex < filtered.length ? String(nextIndex) : null };
}
