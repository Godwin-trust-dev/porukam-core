import { useQueries } from '@tanstack/react-query';
import { useAuthStore } from '../auth/authStore';
import { catalogFiltersActive, nearestLowerExperiencePreset, probeCatalogNonEmpty, type CatalogSearchFilters } from './api';
import { geoFilterActive, useGeoFilterLabel, widenGeoFilter, WORLD_GEO_FILTER, type GeoFilter } from './geoFilter';

/**
 * Разбор пустой выдачи каталога исполнителей на КОНКРЕТНЫЙ совет вместо
 * одной общей заглушки «Никого не нашлось» + сброс всех фильтров (план 11.09
 * §7, ADR-187). Приоритет проверки — гео → сфера → опыт, самый узкий фильтр
 * первым (гео обычно самый глубокий: город → регион → страна → мир):
 *
 * - гео сузило до нуля (город/регион/страна), а на уровень шире кто-то есть —
 *   `widen-geo`, одна кнопка «искать шире» без сброса сферы/опыта;
 * - сфера сузила до нуля именно в выбранном месте — `remove-sphere` (убрать
 *   сферу, гео не помогает) / `remove-geo` (убрать гео, сфера не помогает) /
 *   `sphere-or-geo` (помогает и то, и другое — два действия);
 * - порог опыта отсекает всех — `lower-experience` (ближайший меньший
 *   пресет, а не «любой опыт» сразу, если меньший пресет и так помогает);
 * - фильтров нет вовсе, а каталог пуст — `no-data` (расширять нечего);
 * - ни одно точечное ослабление не помогает — `reset-all` (прежнее общее
 *   поведение, оно же единственный вариант, если каталог пуст сам по себе).
 *
 * Все `probe*` запросы (см. `probeCatalogNonEmpty`, лимит 1) летят
 * ПАРАЛЛЕЛЬНО и только когда `isEmpty` — не на каждое открытие страницы.
 * Отдаём `checking`, пока не пришли данные более приоритетной проверки:
 * без этого на миг мелькнул бы неверный совет (например «сбросить всё»),
 * который тут же сменился бы на «искать шире» после ответа сети.
 */
export type CatalogEmptySuggestion =
  | { kind: 'checking' }
  | { kind: 'no-data' }
  | { kind: 'widen-geo'; next: GeoFilter; label: string }
  | { kind: 'remove-sphere' }
  | { kind: 'remove-geo' }
  | { kind: 'sphere-or-geo' }
  | { kind: 'lower-experience'; next: number | null }
  | { kind: 'reset-all' };

export function useCatalogEmptySuggestion(
  filters: CatalogSearchFilters,
  geoFilter: GeoFilter,
  isEmpty: boolean,
  lang: string,
  worldLabel: string,
): CatalogEmptySuggestion {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const geoActive = geoFilterActive(geoFilter);
  const sphereActive = filters.spheres.length > 0;
  const experienceActive = filters.experienceMin != null;
  // Нечего ослаблять — фильтров нет вовсе. ВНИМАНИЕ (ADR-189, владелец
  // 12.09): с этого момента `SearchPage` вызывает этот хук с `isEmpty=true`
  // ТОЛЬКО когда хотя бы один фильтр уже задан (сам каталог теперь не
  // запрашивается вовсе без фильтра, «весь мир по умолчанию» ADR-185 на
  // экране отменено) — значит на практике `nothingActive` сюда больше не
  // долетает истинным, а `kind: 'no-data'` ниже с этого экрана недостижим.
  // Ветка оставлена как защитный код для этой чистой функции (сигнатура не
  // завязана на конкретного вызывающего) и типа `CatalogEmptySuggestion`.
  const nothingActive = !geoActive && !catalogFiltersActive(filters);

  const widened = geoActive ? widenGeoFilter(geoFilter) : null;
  // Хук вызывается безусловно (правило хуков) — на неактивном гео просто
  // резолвит подпись мира, результат в этой ветке не используется.
  const widenedLabel = useGeoFilterLabel(widened ?? WORLD_GEO_FILTER, lang, worldLabel);
  const lowerExperience = experienceActive ? nearestLowerExperiencePreset(filters.experienceMin as number) : null;

  const enabled = isEmpty && isAuthenticated && !nothingActive;

  const [geoWiden, sphereRemoved, geoRemoved, experienceLowered] = useQueries({
    queries: [
      {
        queryKey: ['dashboard', 'search-catalog-probe', 'geo-widen', widened, filters.spheres, filters.experienceMin],
        queryFn: () => probeCatalogNonEmpty({ ...filters, ...(widened as GeoFilter) }),
        enabled: enabled && geoActive && widened != null,
        staleTime: 10_000,
      },
      {
        queryKey: ['dashboard', 'search-catalog-probe', 'sphere-removed', geoFilter, filters.experienceMin],
        queryFn: () => probeCatalogNonEmpty({ ...filters, spheres: [] }),
        enabled: enabled && sphereActive,
        staleTime: 10_000,
      },
      {
        queryKey: ['dashboard', 'search-catalog-probe', 'geo-removed', filters.spheres, filters.experienceMin],
        queryFn: () => probeCatalogNonEmpty({ ...filters, country: null, region: null, city: null }),
        enabled: enabled && sphereActive && geoActive,
        staleTime: 10_000,
      },
      {
        queryKey: ['dashboard', 'search-catalog-probe', 'experience-lower', geoFilter, filters.spheres, lowerExperience],
        queryFn: () => probeCatalogNonEmpty({ ...filters, experienceMin: lowerExperience }),
        enabled: enabled && experienceActive,
        staleTime: 10_000,
      },
    ],
  });

  if (!isEmpty) return { kind: 'checking' };
  if (nothingActive) return { kind: 'no-data' };

  // Гео — самый узкий фильтр по умолчанию (город/регион/страна), проверяем
  // первым: если уровень шире уже находит кого-то, остальные оси не важны.
  if (geoActive && widened != null) {
    if (geoWiden.data === true) return { kind: 'widen-geo', next: widened, label: widenedLabel };
    if (!geoWiden.isFetched) return { kind: 'checking' };
  }

  if (sphereActive) {
    if (!sphereRemoved.isFetched || (geoActive && !geoRemoved.isFetched)) return { kind: 'checking' };
    const sphereFixes = sphereRemoved.data === true;
    const geoFixes = geoActive && geoRemoved.data === true;
    if (sphereFixes && geoFixes) return { kind: 'sphere-or-geo' };
    if (sphereFixes) return { kind: 'remove-sphere' };
    if (geoFixes) return { kind: 'remove-geo' };
  }

  if (experienceActive) {
    if (!experienceLowered.isFetched) return { kind: 'checking' };
    if (experienceLowered.data === true) return { kind: 'lower-experience', next: lowerExperience };
  }

  return { kind: 'reset-all' };
}
