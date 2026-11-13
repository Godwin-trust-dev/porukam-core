import type { RealContract } from '@porukam/core';
import type { ClientOption } from './draftStore';

export type PaymentOrderCode = NonNullable<RealContract['payment_order']>;

/**
 * ADR-151: порядок оплаты этапа — СРОК оплаты относительно исполнения
 * (замечание владельца 02.09: «предоплата до начала этапа / постоплата после
 * окончания — для всех договоров, в продажах и аренде тоже»). Отдельная ось
 * от способа оплаты (`paymentMethods.ts`): наличными можно платить и до, и
 * после. Коды `before_start`/`after_acceptance`, а не `prepayment` —
 * последний уже занят способом расчёта с другим смыслом.
 */
export const PAYMENT_ORDERS: readonly PaymentOrderCode[] = ['before_start', 'after_acceptance'];

export const PAYMENT_ORDER_LABEL_KEY: Record<PaymentOrderCode, string> = {
  before_start: 'contractNew.paymentOrder_before_start',
  after_acceptance: 'contractNew.paymentOrder_after_acceptance',
};

/** Неприменим к займу (бэк: 400 `payment_order_not_applicable`, гейт `send`
 * поле не требует) — у займа лист-этап и есть денежный транш. */
export function paymentOrderApplicable(option: ClientOption | null): boolean {
  return option !== 'loan';
}

/** То же по коду типа договора (карточка/условия у контрагента — там опции
 * дерева нет, только `contract_type_code`; семейство — первый сегмент кода,
 * как в `contractTypeLabelKey`). */
export function paymentOrderApplicableForType(contractTypeCode: string | null | undefined): boolean {
  return (contractTypeCode ?? '').split('_')[0] !== 'loan';
}

export function paymentOrderLabelKey(code: RealContract['payment_order']): string | undefined {
  return code ? PAYMENT_ORDER_LABEL_KEY[code] : undefined;
}
