import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StageEvidence, StageEvidenceBind, StageExecutionDetail, StageTimelineEvent } from '@porukam/core';
import { api } from '../../shared/api';

/** Сдача этапа + доказательства (DEV-11 §5): доменный запрос — требует X-Acting-Profile
 * (роль — исполнитель, гейт на странице). */
export function useStageExecution(contractId: string, stageId: string, enabled = true) {
  return useQuery({
    queryKey: ['stage-execution', contractId, stageId],
    enabled: !!contractId && !!stageId && enabled,
    queryFn: () => api.request<StageExecutionDetail>(`/contracts/${contractId}/stages/${stageId}`, { actor: true }),
  });
}

export function useStageTimeline(contractId: string, stageId: string, enabled = true) {
  return useQuery({
    queryKey: ['stage-timeline', contractId, stageId],
    enabled: !!contractId && !!stageId && enabled,
    queryFn: () => api.request<StageTimelineEvent[]>(`/contracts/${contractId}/stages/${stageId}/timeline`, { actor: true }),
  });
}

export function useStageExecutionApi(contractId: string, stageId: string) {
  const qc = useQueryClient();
  const key = ['stage-execution', contractId, stageId];
  const timelineKey = ['stage-timeline', contractId, stageId];

  function sync(s: StageExecutionDetail): StageExecutionDetail {
    qc.setQueryData(key, s);
    return s;
  }

  return {
    /** Мок без реального multipart (§0 архитектура мок-слоя) — файл описывается метаданными. */
    async uploadEvidence(file: File, bind: StageEvidenceBind) {
      const evidence = await api.request<StageEvidence>(`/contracts/${contractId}/stages/${stageId}/evidence`, {
        method: 'POST',
        actor: true,
        body: { filename: file.name, mime: file.type, size: file.size, bind },
      });
      await qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: timelineKey });
      return evidence;
    },
    async deleteEvidence(evidenceId: string) {
      await api.request(`/contracts/${contractId}/stages/${stageId}/evidence/${evidenceId}`, {
        method: 'DELETE',
        actor: true,
      });
      await qc.invalidateQueries({ queryKey: key });
    },
    async submit(): Promise<StageExecutionDetail> {
      return sync(
        await api.request<StageExecutionDetail>(`/contracts/${contractId}/stages/${stageId}/submit`, {
          method: 'POST',
          actor: true,
          idempotent: true,
        }),
      );
    },
  };
}

/** Drive-бэкап доказательств (DEV-11 §4, ADR-060 §8) — МОК-ТОЛЬКО, аккаунтный переключатель. */
export function useStageDriveBackup(enabled = true) {
  return useQuery({
    queryKey: ['stage-drive-backup'],
    enabled,
    queryFn: () => api.request<{ connected: boolean }>('/me/drive-backup', { actor: true }),
  });
}

export function useConnectStageDriveBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<{ connected: boolean }>('/me/drive-backup', { method: 'POST', actor: true, idempotent: true }),
    onSuccess: (state) => qc.setQueryData(['stage-drive-backup'], state),
  });
}
