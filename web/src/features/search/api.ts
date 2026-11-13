import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CatalogPage, SearchResponse } from '@porukam/core';
import { api } from '../../shared/api';
import { useAuthStore } from '../auth/authStore';

/** Раздел «Поиск» (ADR-114, зона упрощена — ADR-189): люди по @хендлу/
 * телефону + объединения. Экран больше не даёт выбрать зону (ADR-114
 * `world|country|city` — СВОЯ страна/город зрителя, понятие ДРУГОЕ, чем
 * произвольное место гео-фильтра каталога ниже, см. `geoFilter.ts`) — лукап
 * всегда идёт по всему миру: единственный честный вариант без второго
 * гео-контрола на экране (ADR-189). Запрос короче 2 символов — пустая
 * выдача (зеркало бэка), хук не дёргается. */
export function useSearch(query: string) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['dashboard', 'search', trimmed],
    queryFn: () =>
      api.request<SearchResponse>('/dashboard/search', { actor: true,
        query: { q: trimmed, zone: 'world' },
      }),
    enabled: isAuthenticated && trimmed.length >= 2,
    staleTime: 10_000,
  });
}

/** Панель фильтров каталога (план 11.09 §6, ADR-184/185): `country`/`region`/
 * `city` — на любом ОДНОМ уровне (глубже — приоритет, см. ADR-184; каскад на
 * фронте держит их согласованными сам, см. `GeoCascadeFilter`), `null` —
 * фильтр не применяется вовсе. `experienceMin` — порог завершённых сделок;
 * `null` — без порога. `has_experience` бэка отдельно не используется:
 * `experienceMin=1` — тот же эффект, второй параметр был бы лишним синонимом.
 * `workTypes` — виды работ (ADR-190/191), составные коды `<сфера>.<категория>`,
 * НЕЗАВИСИМЫЙ от `spheres` фильтр (ИЛИ между значениями, И с остальными —
 * тот же приём бэка, что `sphere`, `apps.dashboards`): выбор вида работ не
 * обязан ссылаться на выбранную сферу этого же запроса, хотя на экране
 * (`WorkTypeChipsEditor`) виды работ разворачиваются только под выбранными
 * сферами, так что на практике несогласованная пара с этого экрана не
 * прилетает. */
export interface CatalogSearchFilters {
  country: string | null;
  region: string | null;
  city: number | null;
  spheres: string[];
  workTypes: string[];
  experienceMin: number | null;
}

export const CATALOG_PAGE_SIZE = 20;

export const EMPTY_CATALOG_FILTERS: CatalogSearchFilters = {
  country: null,
  region: null,
  city: null,
  spheres: [],
  workTypes: [],
  experienceMin: null,
};

export function catalogFiltersActive(filters: CatalogSearchFilters): boolean {
  return filters.country != null || filters.spheres.length > 0 || filters.workTypes.length > 0 || filters.experienceMin != null;
}

/** Пресеты порога опыта панели фильтров — те же значения, что `SelectField`
 * `search-experience-filter` в `SearchPage`. Вынесены сюда (а не локальная
 * константа страницы), чтобы разбор пустой выдачи (план 11.09 §7, ADR-187)
 * мог посчитать «ближайший меньший порог» без второго списка значений. */
export const EXPERIENCE_OPTIONS = [1, 3, 5, 10];

/** Ближайший МЕНЬШИЙ порог опыта из стандартных пресетов — `null`, если
 * текущий порог уже минимальный пресет (1): дальше снижать некуда, следующий
 * шаг — снять фильтр опыта вовсе. Пустая выдача каталога (план 11.09 §7,
 * ADR-187) предлагает снизить порог на один пресет, а не сбрасывать фильтры
 * целиком. */
export function nearestLowerExperiencePreset(current: number): number | null {
  const lower = EXPERIENCE_OPTIONS.filter((n) => n < current);
  return lower.length > 0 ? Math.max(...lower) : null;
}

/**
 * Проверка «а есть ли кто-то с ослабленным фильтром» — тот же запрос, что
 * `useCatalogSearch`, но `limit: 1` (нужен только факт непустоты, не сами
 * строки) и без пагинации. Пустая выдача каталога (план 11.09 §7, ADR-187)
 * шлёт его ТОЛЬКО когда основная выдача уже пуста — не на каждое открытие
 * страницы и не на каждое изменение панели.
 */
export async function probeCatalogNonEmpty(filters: CatalogSearchFilters): Promise<boolean> {
  const sortedSpheres = [...filters.spheres].sort();
  const sortedWorkTypes = [...filters.workTypes].sort();
  const r = await api.request<SearchResponse>('/dashboard/search', {
    actor: true,
    query: {
      catalog: 1,
      country: filters.country ?? undefined,
      region: filters.region ?? undefined,
      city: filters.city ?? undefined,
      sphere: sortedSpheres.length > 0 ? sortedSpheres : undefined,
      work_type: sortedWorkTypes.length > 0 ? sortedWorkTypes : undefined,
      experience_min: filters.experienceMin ?? undefined,
      limit: 1,
    },
  });
  return (r.catalog?.items.length ?? 0) > 0;
}

/**
 * Каталог исполнителей (`catalog` ветка `GET /dashboard/search`) — ОТДЕЛЬНЫЙ
 * запрос от `useSearch` выше (адресный лукап по `q` не трогаем, ADR-184
 * «часть 6 не переделывает существующий блок»): с любым заданным фильтром
 * шлём `catalog=1` явно, без фильтров — тоже «весь мир» на уровне API
 * (ADR-185 не отменена, бэк по-прежнему готов отдать весь мир без единого
 * параметра). Но экран `/search` теперь сам решает, когда вообще звать этот
 * хук: `enabled` ниже — это ТРЕБОВАНИЕ ВЫЗЫВАЮЩЕЙ СТОРОНЫ (владелец 12.09:
 * «не показывай никого, пока не введён поисковый или фильтрационный
 * запрос»), а не проверка авторизации внутри хука — см. `SearchPage`
 * (`filtersActive`) и ADR-189, раздел «Стартовое состояние каталога».
 * Пагинация — keyset (`next_cursor`), `useInfiniteQuery` — тот же приём, что
 * `useNotificationsFeed` (`features/notifications/api.ts`).
 */
export function useCatalogSearch(filters: CatalogSearchFilters, enabled: boolean) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Порядок кодов сфер/видов работ не влияет на результат (ИЛИ между
  // значениями) — но влияет на ключ запроса, если не нормализовать: выбор тех
  // же значений в другом порядке не должен считаться новым запросом/сбрасывать
  // страницы.
  const sortedSpheres = [...filters.spheres].sort();
  const sortedWorkTypes = [...filters.workTypes].sort();
  return useInfiniteQuery({
    queryKey: ['dashboard', 'search-catalog', filters.country, filters.region, filters.city, sortedSpheres, sortedWorkTypes, filters.experienceMin],
    queryFn: ({ pageParam }) =>
      api
        .request<SearchResponse>('/dashboard/search', {
          actor: true,
          query: {
            catalog: 1,
            country: filters.country ?? undefined,
            region: filters.region ?? undefined,
            city: filters.city ?? undefined,
            sphere: sortedSpheres.length > 0 ? sortedSpheres : undefined,
            work_type: sortedWorkTypes.length > 0 ? sortedWorkTypes : undefined,
            experience_min: filters.experienceMin ?? undefined,
            limit: CATALOG_PAGE_SIZE,
            cursor: pageParam ?? undefined,
          },
        })
        .then((r): CatalogPage => r.catalog ?? { items: [], next_cursor: null }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: isAuthenticated && enabled,
  });
}
