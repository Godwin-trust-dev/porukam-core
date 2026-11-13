import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ContractTypeOption, MaterialCatalogItem, SphereSearchResponse, UnitOption, WorkType } from '@porukam/core';
import { api } from '../../shared/api';

/** ADR-094 — типы клиентского дерева: явные коды для Продажи/Аренды/Займа
 * («Услуга» резолвится сервером по `client_option`, ей код не нужен). */
export function useContractTypes(clientOption: string | null) {
  return useQuery({
    queryKey: ['contract-types', clientOption],
    enabled: !!clientOption,
    queryFn: () =>
      api
        .request<{ results: ContractTypeOption[] }>('/contract-types', { query: { client_option: clientOption ?? undefined } })
        .then((r) => r.results),
  });
}

/** DEV-09 §3 — сферы (SpherePicker): популярные + поиск; с `q` ещё и
 * совпавшие типы работ (`work_types`, ADR-100). */
export function useSpheres(q: string) {
  return useQuery({
    queryKey: ['spheres', q],
    // Пока грузится выдача нового запроса, показываем предыдущую — без
    // placeholderData список моргает пустым на каждое нажатие клавиши
    // (data = undefined между запросами), и SpherePicker вспыхивал emptyHint.
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.request<SphereSearchResponse>('/spheres', { query: { q: q || undefined } }),
  });
}

/** DEV-09 §3 — типы работ внутри выбранной сферы. Вынесено отдельно от
 * `useWorkTypes` (ADR-191): `WorkTypeChipsEditor` (профиль/поиск — «виды
 * работ») запрашивает НЕСКОЛЬКО сфер разом через `useQueries`, которому
 * нужны голые опции запроса, а не готовый хук с `enabled`. Тот же
 * `queryKey`, что и раньше — кэш общий с мастером договора. */
export function workTypesQueryOptions(sphereCode: string) {
  return {
    queryKey: ['work-types', sphereCode] as const,
    queryFn: () => api.request<{ results: WorkType[] }>('/work-types', { query: { sphere: sphereCode } }).then((r) => r.results),
  };
}

/** DEV-09 §3 — типы работ внутри выбранной сферы. */
export function useWorkTypes(sphereCode: string) {
  return useQuery({ ...workTypesQueryOptions(sphereCode), enabled: !!sphereCode });
}

/** DEV-09 §4.3 — каталог материалов (MaterialsModal). `sphere` опционален
 * (ADR-091): со сферой договора список короче и содержит ОДНУ позицию
 * «Прочее» (`other_<sphere>`) вместо десятка одинаковых по всем сферам. */
export function useMaterialCatalog(sphere?: string) {
  return useQuery({
    queryKey: ['material-catalog', sphere ?? ''],
    queryFn: () =>
      api
        .request<{ results: MaterialCatalogItem[] }>('/material-catalog', { query: { sphere: sphere || undefined } })
        .then((r) => r.results),
  });
}

/** DEV-09 §4.3 — единицы измерения (UnitPicker). */
export function useUnits() {
  return useQuery({
    queryKey: ['units'],
    queryFn: () => api.request<{ results: UnitOption[] }>('/units').then((r) => r.results),
  });
}

/** DEV-09 §4.2 — рекомендуемый чек-лист по типу работ (предзаполнение).
 * `sphere` обязателен вместе с `workType` (ADR-091 §1): «вид работ» —
 * категория каталожного чек-листа, не уникальна глобально («other» почти в
 * каждой сфере) — без сферы в фильтре рекомендации разных сфер бы путались. */
export function useChecklistRecommendations(sphere: string, workType: string) {
  return useQuery({
    queryKey: ['checklist-recommendations', sphere, workType],
    enabled: !!sphere && !!workType,
    queryFn: () =>
      api.request<{ results: string[] }>('/checklist-recommendations', { query: { sphere, workType } }).then((r) => r.results),
  });
}

