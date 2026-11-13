/**
 * РЕАЛЬНЫЙ платёжный контур (`apps.payments`, Э5 волна 1 — ADR-130).
 * ОТДЕЛЬНО от `./api.ts` рядом (старый мок-контур `Payment`/`usePayment`
 * с эквайрингом и СБП-банками — тот НЕ трогается, им живёт `PaymentPage`
 * вне этой волны), тот же приём, что `features/contracts/realApi.ts`
 * рядом со старым `features/contracts/api.ts`.
 *
 * Источник правды о деньгах — `Payment`, а не отметки на узле этапа:
 * `Milestone.paid_confirmed_*_at` остались зеркалом, которое пишет только
 * `apps.payments.services`. Поэтому и вкладка «Оплаты», и блок оплаты на
 * экране этапа читают ОДИН ресурс — `GET /contracts/{id}/payments`, а не
 * `/dashboard/payments` (ADR-109, витрина раздела) и не дерево этапов.
 *
 * `direct_platform`/`hold` требуют платёжного партнёра, которого нет:
 * счета по таким договорам не выставляются вовсе — список приезжает
 * ПУСТЫМ (бэк молча возвращает `[]` из `ensure_contract_payments`), а
 * попытка выставления отвечает 409 `payment_provider_not_configured`.
 * Объяснение вместо кнопок — `PlatformPaymentNotice`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RealPayment, RealPaymentListResponse } from '@porukam/core';
import { api } from '../../shared/api';

export const REAL_PAYMENTS_QK = {
  contract: (contractId: string | undefined) => ['real-payments', contractId] as const,
};

/** `GET /v1/contracts/{id}/payments` → `{items: Payment[]}`.
 *
 * У GET есть побочный эффект НА БЭКЕ («read-repair»,
 * `services.ensure_contract_payments`): счета материализует подписчик
 * outbox, но реле — фоновый свип, а карточку открывают сразу после
 * приёмки. Для клиента это обычное чтение — идемпотентность держит
 * `UNIQUE (milestone, kind)`. */
export function useRealContractPayments(contractId: string | undefined) {
  return useQuery({
    queryKey: REAL_PAYMENTS_QK.contract(contractId),
    enabled: !!contractId,
    queryFn: async () => {
      const res = await api.request<RealPaymentListResponse>(`/contracts/${contractId}/payments`, { actor: true });
      return res.items;
    },
  });
}

/** Инвалидация после денежного действия. Платёж виден не только там, где
 * его подтвердили: вкладка «Оплаты», сам договор (последний оплаченный
 * лист переводит исполнение в `warranty`), дерево и карточка этапа
 * (зеркало `paid_confirmed_*_at` + гейт `payment_not_confirmed`), лента и
 * раздел `/dashboard/payments`. */
function invalidateAfterPayment(qc: ReturnType<typeof useQueryClient>, payment: RealPayment): void {
  void qc.invalidateQueries({ queryKey: REAL_PAYMENTS_QK.contract(payment.contract_id) });
  void qc.invalidateQueries({ queryKey: ['real-contract', payment.contract_id] });
  void qc.invalidateQueries({ queryKey: ['real-milestones', payment.contract_id] });
  void qc.invalidateQueries({ queryKey: ['real-timeline', payment.contract_id] });
  void qc.invalidateQueries({ queryKey: ['real-milestone', payment.milestone_id] });
  void qc.invalidateQueries({ queryKey: ['real-milestone-gate', payment.milestone_id] });
  void qc.invalidateQueries({ queryKey: ['real-milestone-timeline', payment.milestone_id] });
  void qc.invalidateQueries({ queryKey: ['dashboard', 'payments'] });
}

/** `POST /v1/payments/{id}/confirm` — денежный POST, `Idempotency-Key`
 * ОБЯЗАТЕЛЕН (иначе 400 `idempotency_key_required`; в отличие от
 * унаследованных `/milestones/{id}/confirm-*`, где он лишь honoured).
 * Ключ генерирует `ApiClient` по флагу `idempotent` — тот же хелпер, что
 * у `submit`/`accept`/`sign`.
 *
 * `side` в теле НЕ шлём: сторона выводится бэком из роли вызывающего, а
 * переданное значение только сверяется с ней. Повтор той же стороной —
 * no-op с текущим состоянием, не 409. */
export function useConfirmRealPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) =>
      api.request<RealPayment>(`/payments/${paymentId}/confirm`, { method: 'POST', body: {}, actor: true, idempotent: true }),
    onSuccess: (payment) => invalidateAfterPayment(qc, payment),
  });
}

/** `POST /v1/payments/{id}/cancel` — отзыв ошибочно выставленного счёта.
 * ТОЛЬКО из `pending` (409 `invalid_payment_transition` иначе): как только
 * сторона зафиксировала денежный факт, обратный ход — это возврат, а не
 * отмена. Любой стороной — счёт не односторонняя претензия. */
export function useCancelRealPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason?: string }) =>
      api.request<RealPayment>(`/payments/${paymentId}/cancel`, {
        method: 'POST',
        body: reason ? { reason } : {},
        actor: true,
        idempotent: true,
      }),
    onSuccess: (payment) => invalidateAfterPayment(qc, payment),
  });
}
