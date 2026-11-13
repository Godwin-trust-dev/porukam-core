import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortfolioProjectDto } from '@porukam/core';
import { api } from '../../shared/api';

/** Портфолио (ADR-115). Список — AllowAny (витрина: карточка репутации
 * читает без входа), мутации — владелец. */

export function usePortfolioProjects(profileId: string | undefined) {
  return useQuery({
    queryKey: ['portfolio', profileId],
    queryFn: () => api.request<PortfolioProjectDto[]>(`/profiles/${profileId}/portfolio/projects`),
    enabled: !!profileId,
  });
}

function useInvalidatePortfolio(profileId: string | undefined) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['portfolio', profileId] });
}

/** Поля формы проекта (ADR-120): дата завершения ОБЯЗАТЕЛЬНА, начало и
 * город — нет; описание без лимита. Даты — ISO `YYYY-MM-DD`. */
export interface PortfolioProjectInput {
  title: string;
  sphere: string;
  description: string;
  started_at: string | null;
  completed_at: string;
  location_label: string;
}

export function useCreatePortfolioProject(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: (input: PortfolioProjectInput) =>
      api.request<PortfolioProjectDto>(`/profiles/${profileId}/portfolio/projects`, {
        method: 'POST',
        body: input,
        actor: true,
      }),
    onSuccess: invalidate,
  });
}

/** `PATCH /portfolio/projects/{id}` (ADR-120) — редактирование, в т.ч. сферы и дат;
 * 422 `portfolio_dates_invalid`. */
export function useUpdatePortfolioProject(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: ({ projectId, patch }: { projectId: string; patch: Partial<PortfolioProjectInput> }) =>
      api.request<PortfolioProjectDto>(`/portfolio/projects/${projectId}`, { method: 'PATCH', body: patch, actor: true }),
    onSuccess: invalidate,
  });
}

/** `POST /portfolio/projects/{id}/photos` (ADR-120) — добавить фото в галерею (до 5);
 * 409 `portfolio_photos_limit`, 413 `portfolio_photo_too_large`, 422 `invalid_portfolio_image`. */
export function useAddProjectPhoto(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: ({ projectId, file }: { projectId: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return api.request<PortfolioProjectDto>(`/portfolio/projects/${projectId}/photos`, { method: 'POST', body: form, actor: true });
    },
    onSuccess: invalidate,
  });
}

export function useRemoveProjectPhotoItem(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: ({ projectId, photoId }: { projectId: string; photoId: string }) =>
      api.request<PortfolioProjectDto>(`/portfolio/projects/${projectId}/photos/${photoId}`, { method: 'DELETE', actor: true }),
    onSuccess: invalidate,
  });
}

export function useSetPrimaryProjectPhoto(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: ({ projectId, photoId }: { projectId: string; photoId: string }) =>
      api.request<PortfolioProjectDto>(`/portfolio/projects/${projectId}/photos/${photoId}/primary`, { method: 'POST', body: {}, actor: true }),
    onSuccess: invalidate,
  });
}

export function useUploadProjectPhoto(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: ({ projectId, file }: { projectId: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return api.request<PortfolioProjectDto>(`/portfolio/projects/${projectId}/photo`, {
        method: 'POST',
        body: form,
        actor: true,
      });
    },
    onSuccess: invalidate,
  });
}

export function useRemoveProjectPhoto(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: (projectId: string) =>
      api.request<PortfolioProjectDto>(`/portfolio/projects/${projectId}/photo`, {
        method: 'DELETE',
        actor: true,
      }),
    onSuccess: invalidate,
  });
}

export function usePublishProject(profileId: string | undefined) {
  const invalidate = useInvalidatePortfolio(profileId);
  return useMutation({
    mutationFn: (projectId: string) =>
      api.request<PortfolioProjectDto>(`/portfolio/projects/${projectId}/publish`, {
        method: 'POST',
        body: {},
        actor: true,
      }),
    onSuccess: invalidate,
  });
}
