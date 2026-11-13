import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkArea, WorkAreaWriteItem } from '@porukam/core';
import { api } from '../../shared/api';

/**
 * Регионы работы профиля — `GET`/`PUT /v1/profiles/{id}/work-areas`
 * (план 11.09 §4, ADR-182). Приватный список (не витрина) — владелец либо
 * представитель с `manage_profile`, чужой профиль → 403. `PUT` — полная
 * ИДЕМПОТЕНТНАЯ замена (не PATCH-дельта): редактор всегда шлёт весь список
 * (тот же приём, что `SphereChipsEditor` + `PATCH sphere_codes`, только тут
 * отдельный эндпоинт, а не поле профиля).
 */
export function useWorkAreas(profileId: string | undefined) {
  return useQuery({
    queryKey: ['work-areas', profileId],
    queryFn: () => api.request<WorkArea[]>(`/profiles/${profileId}/work-areas`),
    enabled: Boolean(profileId),
  });
}

export function useReplaceWorkAreas(profileId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: WorkAreaWriteItem[]) => {
      if (!profileId) throw new Error('useReplaceWorkAreas: profileId ещё не известен');
      return api.request<WorkArea[]>(`/profiles/${profileId}/work-areas`, { method: 'PUT', body: items });
    },
    onSuccess: (data) => qc.setQueryData(['work-areas', profileId], data),
  });
}
