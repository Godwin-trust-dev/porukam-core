/**
 * Зеркало compute_segment — ТОЛЬКО для UX-предпросчёта сегмента до запроса
 * (ТЗ §4: «зеркала логики — не для истины»). Итоговый сегмент считает бэкенд;
 * при расхождении UI показывает ответ сервера.
 *
 * Ф1: минимальная эвристика для превью-подписи в списке/создании.
 * Полная матрица (ADR-058) — в Ф4.
 */
import type { ContractSegment, ProfileKind } from './api/types';

export interface SegmentInput {
  /** Обе стороны — физлица без бизнес-статуса и без оплаты. */
  customerKind: ProfileKind;
  contractorKind: ProfileKind;
  isPaid: boolean;
}

export function previewSegment(input: SegmentInput): ContractSegment {
  const bothPersons = input.customerKind === 'person' && input.contractorKind === 'person';
  if (bothPersons && !input.isPaid) return 'free_c2c';
  if (bothPersons && input.isPaid) return 'paid_c2c';
  if (input.customerKind === 'business' || input.contractorKind === 'business') return 'paid_business';
  return 'special';
}

/** Для free_c2c — никаких упоминаний комиссии (ТЗ §2 п.7, ADR-058). */
export function hasContractFee(segment: ContractSegment): boolean {
  return segment === 'paid_c2c' || segment === 'paid_business';
}
