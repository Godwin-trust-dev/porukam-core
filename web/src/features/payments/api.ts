import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Payment, PaymentMethodKind } from '@porukam/core';
import { api } from '../../shared/api';
import { useViewerStore } from '../contracts/viewerStore';

/** DEV-07 — платёж по этапу. Пока `pending` (СБП обрабатывается провайдером), опрашиваем раз в секунду. */
export function usePayment(pid: string | undefined) {
  return useQuery({
    queryKey: ['payment', pid],
    enabled: !!pid,
    queryFn: () => api.request<Payment>(`/payments/${pid}`, { actor: true }),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 1000 : false),
  });
}

export function useCreatePayment(contractId: string) {
  const viewAs = useViewerStore((s) => s.viewAs);
  return useMutation({
    mutationFn: (input: { stageId: string; method: PaymentMethodKind }) =>
      api.request<Payment>(`/contracts/${contractId}/payments`, {
        method: 'POST',
        body: input,
        actor: true,
        idempotent: true,
        headers: { 'X-Mock-Role': viewAs },
      }),
  });
}

export function useConfirmPayment(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (by: 'payer' | 'payee') =>
      api.request<Payment>(`/payments/${pid}/confirm`, { method: 'POST', body: { by }, actor: true, idempotent: true }),
    onSuccess: (p) => qc.setQueryData(['payment', pid], p),
  });
}

/** «Что-то не так?» / «Не получили?» — ведёт в спор, отметки при этом не откатываются (ADR-019/020). */
export function useDisputePayment(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<Payment>(`/payments/${pid}/dispute`, { method: 'POST', actor: true, idempotent: true }),
    onSuccess: (p) => qc.setQueryData(['payment', pid], p),
  });
}
