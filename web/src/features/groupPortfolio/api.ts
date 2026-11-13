import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroupPortfolioProjectDto } from '@porukam/core';
import { api } from '../../shared/api';

/** Портфолио объединения (ADR-128). Список — как карточка объединения
 * (публичное видно и гостю), мутации — только leader/admin. Все пути
 * скоупятся объединением: чужой project_id даёт 404, а не 403. */

const key = (groupId: string | undefined) => ['groupPortfolio', groupId];

const base = (groupId: string | undefined) => `/groups/${groupId}/portfolio/projects`;

export function useGroupPortfolio(groupId: string | undefined) {
  return useQuery({
    queryKey: key(groupId),
    queryFn: () => api.request<GroupPortfolioProjectDto[]>(base(groupId)),
    enabled: !!groupId,
  });
}

function useInvalidateGroupPortfolio(groupId: string | undefined) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: key(groupId) });
}

/** Поля формы работы объединения: дата завершения ОБЯЗАТЕЛЬНА, начало и город —
 * нет; `sphere_code` пустой = сфера самого объединения. Даты — ISO `YYYY-MM-DD`. */
export interface GroupPortfolioInput {
  title: string;
  sphere_code: string;
  description: string;
  started_at: string | null;
  completed_at: string;
  location_label: string;
}

export function useCreateGroupProject(groupId: string | undefined) {
  const invalidate = useInvalidateGroupPortfolio(groupId);
  return useMutation({
    mutationFn: (input: GroupPortfolioInput) =>
      api.request<GroupPortfolioProjectDto>(base(groupId), { method: 'POST', body: input, actor: true }),
    onSuccess: invalidate,
  });
}

/** 422 `portfolio_dates_invalid` / `invalid_sphere`, 403 `permission_denied`. */
export function useUpdateGroupProject(groupId: string | undefined) {
  const invalidate = useInvalidateGroupPortfolio(groupId);
  return useMutation({
    mutationFn: ({ projectId, patch }: { projectId: string; patch: Partial<GroupPortfolioInput> }) =>
      api.request<GroupPortfolioProjectDto>(`${base(groupId)}/${projectId}`, { method: 'PATCH', body: patch, actor: true }),
    onSuccess: invalidate,
  });
}

/** Удаление работы — физическое, вместе с фото (ADR-128 §5). */
export function useDeleteGroupProject(groupId: string | undefined) {
  const invalidate = useInvalidateGroupPortfolio(groupId);
  return useMutation({
    mutationFn: (projectId: string) =>
      api.request<void>(`${base(groupId)}/${projectId}`, { method: 'DELETE', actor: true }),
    onSuccess: invalidate,
  });
}

/** 409 `portfolio_photos_limit`, 413 `portfolio_photo_too_large`, 422 `invalid_portfolio_image`. */
export function useAddGroupProjectPhoto(groupId: string | undefined) {
  const invalidate = useInvalidateGroupPortfolio(groupId);
  return useMutation({
    mutationFn: ({ projectId, file }: { projectId: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return api.request<GroupPortfolioProjectDto>(`${base(groupId)}/${projectId}/photos`, { method: 'POST', body: form, actor: true });
    },
    onSuccess: invalidate,
  });
}

export function useRemoveGroupProjectPhoto(groupId: string | undefined) {
  const invalidate = useInvalidateGroupPortfolio(groupId);
  return useMutation({
    mutationFn: ({ projectId, photoId }: { projectId: string; photoId: string }) =>
      api.request<GroupPortfolioProjectDto>(`${base(groupId)}/${projectId}/photos/${photoId}`, { method: 'DELETE', actor: true }),
    onSuccess: invalidate,
  });
}

export function useSetPrimaryGroupProjectPhoto(groupId: string | undefined) {
  const invalidate = useInvalidateGroupPortfolio(groupId);
  return useMutation({
    mutationFn: ({ projectId, photoId }: { projectId: string; photoId: string }) =>
      api.request<GroupPortfolioProjectDto>(`${base(groupId)}/${projectId}/photos/${photoId}/primary`, { method: 'POST', body: {}, actor: true }),
    onSuccess: invalidate,
  });
}
