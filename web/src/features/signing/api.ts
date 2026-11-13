import type { ContractDetail, PaymentPolicy } from '@porukam/core';
import { useContract, useContractApi } from '../contracts/api';

/** DEV-05 · Подписание — тонкий feature-хук поверх договорного контура (Ф2). */
export function useSigningContract(id: string | undefined) {
  return useContract(id);
}

/**
 * Единая точка чтения денежной политики юрисдикции (DEV-05-PATCH, ADR-032) —
 * money-компоненты экрана подписания читают её отсюда, не из отдельных полей.
 */
export function usePaymentPolicy(c: ContractDetail): PaymentPolicy {
  return c.payment_policy;
}

export function useSigningApi(id: string) {
  const api = useContractApi(id);

  return {
    viewAs: api.viewAs,
    /** Заморожено, но подписи ещё не запрошены — переводим в awaiting_signatures один раз (идемпотентно по статусу). */
    async ensureRequested(c: ContractDetail): Promise<ContractDetail> {
      if (c.status === 'pending_signature') return api.post('/signature-requests');
      return c;
    },
    /** AiSummaryCard показан фактом нахождения на экране подписания. */
    async showAiSummary(): Promise<ContractDetail> {
      return api.post('/ai-summary-shown');
    },
    async sign(): Promise<ContractDetail> {
      return api.post('/sign');
    },
    /** Возврат на редактирование — аннулирует подписи и версию (ADR-006). */
    async reopen(): Promise<ContractDetail> {
      return api.post('/decline');
    },
  };
}
