import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AcceptanceRemark, MilestoneAcceptance } from '@porukam/core';
import { api } from '../../shared/api';

/** Приёмка этапа (DEV-04 §5): доменный запрос — требует X-Acting-Profile (роль — заказчик, гейт на странице). */
export function useMilestoneAcceptance(contractId: string, milestoneId: string, enabled = true) {
  return useQuery({
    queryKey: ['milestone-acceptance', contractId, milestoneId],
    enabled: !!contractId && !!milestoneId && enabled,
    queryFn: () => api.request<MilestoneAcceptance>(`/contracts/${contractId}/milestones/${milestoneId}`, { actor: true }),
  });
}

export function useAcceptanceApi(contractId: string, milestoneId: string) {
  const qc = useQueryClient();
  const key = ['milestone-acceptance', contractId, milestoneId];

  function sync(m: MilestoneAcceptance): MilestoneAcceptance {
    qc.setQueryData(key, m);
    return m;
  }

  return {
    async accept(): Promise<MilestoneAcceptance> {
      return sync(
        await api.request<MilestoneAcceptance>(`/contracts/${contractId}/milestones/${milestoneId}/accept`, {
          method: 'POST',
          actor: true,
          idempotent: true,
        }),
      );
    },
    async returnWithRemarks(remarks: AcceptanceRemark[]): Promise<MilestoneAcceptance> {
      return sync(
        await api.request<MilestoneAcceptance>(`/contracts/${contractId}/milestones/${milestoneId}/return`, {
          method: 'POST',
          body: { remarks },
          actor: true,
          idempotent: true,
        }),
      );
    },
  };
}
