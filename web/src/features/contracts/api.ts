import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AmendmentSummary,
  ContractDetail,
  ContractsListQuery,
  ContractsListResult,
  HandleEntry,
  MilestoneNode,
  MoneyLike,
  PayoutAccount,
  TimelineEvent,
} from '@porukam/core';
import { api } from '../../shared/api';
import { useViewerStore } from './viewerStore';

// ── Запросы ──
/** Префикс-поиск хендлов (ADR-092). `enabled=false` — запрос не уходит: книга
 * контактов ищет по платформе только после явного «Искать … на платформе». */
export function useHandleSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: ['handles', q],
    enabled,
    queryFn: () => api.request<{ results: HandleEntry[] }>('/handles', { query: { q } }).then((r) => r.results),
  });
}

export function useContract(id: string | undefined) {
  return useQuery({
    queryKey: ['contract', id],
    enabled: !!id,
    queryFn: () => api.request<ContractDetail>(`/contracts/${id}`, { actor: true }),
  });
}


export function useTimeline(id: string | undefined) {
  return useQuery({
    queryKey: ['timeline', id],
    enabled: !!id,
    queryFn: () =>
      api.request<{ results: TimelineEvent[] }>(`/contracts/${id}/timeline`, { actor: true }).then((r) => r.results),
  });
}

export interface StageTreeApiItem {
  id: string;
  ix: number;
  name: string;
  meta?: string;
  sum: MoneyLike | null;
  status: MilestoneNode['status'];
  materials: MilestoneNode['materials'];
}

/** DEV-06 §6 — дерево этапов исполнения (только листья, с материалами). */
export function useStages(id: string | undefined) {
  return useQuery({
    queryKey: ['stages', id],
    enabled: !!id,
    queryFn: () => api.request<{ results: StageTreeApiItem[] }>(`/contracts/${id}/stages`, { actor: true }).then((r) => r.results),
  });
}

export interface PaymentPlanResponse {
  rows: { id: string; stage: string; note?: string; amount: MoneyLike; state: 'paid' | 'due' | 'later' }[];
  /** Наследие мока (финмодель v2: всегда undefined, contract_fee не начисляется — не используется в UI). */
  commission?: { status: 'pending' | 'charged' | 'failed' };
}

/** DEV-06 §6 — план расчётов по этапам. */
export function usePaymentPlan(id: string | undefined) {
  return useQuery({
    queryKey: ['payment-plan', id],
    enabled: !!id,
    queryFn: () => api.request<PaymentPlanResponse>(`/contracts/${id}/payment-plan`, { actor: true }),
  });
}

export interface ContractHistoryResponse {
  events: TimelineEvent[];
  amendments: AmendmentSummary[];
}

/** DEV-06 §6 — история: хроника + допники. */
export function useContractHistory(id: string | undefined) {
  return useQuery({
    queryKey: ['history', id],
    enabled: !!id,
    queryFn: () => api.request<ContractHistoryResponse>(`/contracts/${id}/history`, { actor: true }),
  });
}

export function usePayoutAccounts() {
  return useQuery({
    queryKey: ['payout-accounts'],
    queryFn: () => api.request<{ results: PayoutAccount[] }>('/payout-accounts').then((r) => r.results),
  });
}

// ── Действия (мутации) ──
/**
 * Единый низкоуровневый вызов действий над договором: подставляет контекст
 * актёра, dev-роль (X-Mock-Role) и Idempotency-Key, обновляет кеш деталью.
 * Ошибки (валидации FSM, confirm_summary, fee_failure) пробрасываются вызвавшему.
 */
export function useContractApi(id: string) {
  const qc = useQueryClient();
  const viewAs = useViewerStore((s) => s.viewAs);
  const headers = { 'X-Mock-Role': viewAs };

  function sync(c: ContractDetail): ContractDetail {
    // Деталь — источник истины: пишем прямо в кеш. Timeline держим
    // в этом же объекте (timeline берётся из detail при открытии вкладки),
    // поэтому не инвалидируем их здесь — лишние refetch дёргают ре-рендер и
    // отцепляют кнопки посреди клика. Список сделок обновляем отложенно.
    qc.setQueryData(['contract', id], c);
    qc.setQueryData(['timeline', id], c.timeline);
    void qc.invalidateQueries({ queryKey: ['contracts'], refetchType: 'inactive' });
    return c;
  }

  return {
    viewAs,
    async post(path: string, body?: unknown): Promise<ContractDetail> {
      return sync(
        await api.request<ContractDetail>(`/contracts/${id}${path}`, {
          method: 'POST',
          body,
          actor: true,
          idempotent: true,
          headers,
        }),
      );
    },
    async patch(path: string, body?: unknown): Promise<ContractDetail> {
      return sync(
        await api.request<ContractDetail>(`/contracts/${id}${path}`, { method: 'PATCH', body, actor: true, headers }),
      );
    },
    async del(path: string): Promise<ContractDetail> {
      return sync(await api.request<ContractDetail>(`/contracts/${id}${path}`, { method: 'DELETE', actor: true, headers }));
    },
  };
}

export function useAddPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: 'sbp' | 'card' | 'account'; masked: string }) =>
      api.request<PayoutAccount>('/payout-accounts', { method: 'POST', body: input, actor: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payout-accounts'] }),
  });
}

// ── DEV-13 · Список сделок / «Мои договоры» ──

/** GET /v1/contracts?tab=&role=&status=&sphere=&pay=&q=&sort= (§7) — ключ `['contracts', query]`
 * совпадает с тем, что уже инвалидирует `useContractApi().sync()` после мутаций договора. */
export function useContractsList(query: ContractsListQuery) {
  return useQuery({
    queryKey: ['contracts', query],
    queryFn: () =>
      api.request<ContractsListResult>('/contracts', {
        actor: true,
        query: {
          tab: query.tab,
          role: query.role,
          status: query.status,
          sphere: query.sphere,
          pay: query.pay,
          q: query.q,
          sort: query.sort,
        },
      }),
  });
}

// useDeleteDraft / useCreateDraftFromSource удалены (ADR-088 Фаза 2): реального
// DELETE /contracts/{id} на бэке НЕТ (удаление черновика невозможно), «как в
// прошлый раз» живёт на реальных полях в realApi.useCreateRealContractFromSource.
