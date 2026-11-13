/**
 * Экспорт архива сделки — реальный контур `apps.archive` (ADR-139, DEV-12 §12).
 * Один и тот же контракт в mock- и real-режиме: MSW (`archiveHandlers.ts`)
 * зеркалит бэк, отдельной «фазовой заглушки» больше нет.
 *
 *  - `GET /contracts/{id}/archive` — превью состава + `retention` + `exports[]`
 *    (последние сверху) — доменный запрос, требует X-Acting-Profile.
 *  - `POST …/archive/export` — 202 `{export_id, jobId, status}`; `Idempotency-Key`
 *    обязателен (400 без него) — сборка тяжёлая, повтор с тем же ключом —
 *    тот же ответ. 409 `archive_nothing_to_export`, 422 `archive_options_conflict`.
 *  - `GET …/archive/export/{export_id}` — поллинг до `ready|failed`; можно уйти
 *    с экрана и вернуться — незавершённые сборки видны в `exports[]` превью.
 *  - `POST /archive/links/{id}/revoke` — отзыв своей ссылки `/a/<token>` (любой
 *    стороной договора: письмо могло утечь у любой из них, ADR-139 §7).
 *
 * Скачивание — обычные `<a href>` на `/a/<token>` (без Authorization; в PWA
 * автосохранения нет — ADR-137), клиент байты не гоняет.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArchiveLink, ArchivePreview, ExportAccepted, ExportJob, ExportOptionsInput } from '@porukam/core';
import { api } from '../../shared/api';

export const ARCHIVE_QK = {
  preview: (contractId: string | undefined) => ['archive-preview', contractId] as const,
  job: (contractId: string | undefined, exportId: string | null | undefined) => ['archive-export-job', contractId, exportId] as const,
};

/** Интервал поллинга идущей сборки. Бэк отдаёт `progress` 0/50/100 — чаще секунды смысла нет. */
export const EXPORT_POLL_MS = 1000;

export function isExportActive(status: ExportJob['status'] | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export function useArchivePreview(contractId: string, enabled = true) {
  return useQuery({
    queryKey: ARCHIVE_QK.preview(contractId),
    enabled: !!contractId && enabled,
    queryFn: () => api.request<ArchivePreview>(`/contracts/${contractId}/archive`, { actor: true }),
  });
}

/** Поллинг состояния сборки, пока `queued|running`; терминальное состояние
 * инвалидирует превью (в `exports[]` появятся артефакты и ссылки). */
export function useExportJob(contractId: string, exportId: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ARCHIVE_QK.job(contractId, exportId),
    enabled: !!contractId && !!exportId,
    queryFn: async () => {
      const job = await api.request<ExportJob>(`/contracts/${contractId}/archive/export/${exportId}`, { actor: true });
      if (!isExportActive(job.status)) void qc.invalidateQueries({ queryKey: ARCHIVE_QK.preview(contractId) });
      return job;
    },
    refetchInterval: (query) => (isExportActive(query.state.data?.status) ? EXPORT_POLL_MS : false),
  });
}

export function useStartExport(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (options: ExportOptionsInput) =>
      api.request<ExportAccepted>(`/contracts/${contractId}/archive/export`, {
        method: 'POST',
        body: options,
        actor: true,
        idempotent: true,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ARCHIVE_QK.preview(contractId) }),
  });
}

export function useRevokeArchiveLink(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.request<ArchiveLink>(`/archive/links/${linkId}/revoke`, { method: 'POST', actor: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ARCHIVE_QK.preview(contractId) });
      void qc.invalidateQueries({ queryKey: ['archive-export-job', contractId] });
    },
  });
}
