/**
 * Комиссия за заключение договора (ADR-054): маржинальная убывающая шкала,
 * только платные сегменты. Платежи — 0% комиссии платформы (ADR-055).
 *
 * Шкала — ДАННЫЕ, не код (в Ф6 приедет из бэкенда/FeeScheduleTier). Значения
 * подобраны под контрольную точку задачи §0.3: 120 000 ₽ → 1 020 ₽. [Ф-решение],
 * финальные границы/ставки — за ADR-054.
 *
 * Проверка 120 000: 50 000·1.2% (600) + 70 000·0.6% (420) = 1 020.
 */
import { hasContractFee } from './segment';
import type { ContractSegment } from './api/types';
import type { MoneyLike } from './money';

export interface FeeTier {
  /** Верхняя граница диапазона (включительно), null — «и выше». */
  upTo: number | null;
  /** Маржинальная ставка на часть суммы в этом диапазоне. */
  rate: number;
}

export const FEE_TIERS: FeeTier[] = [
  { upTo: 50_000, rate: 0.012 },
  { upTo: 150_000, rate: 0.006 },
  { upTo: 500_000, rate: 0.004 },
  { upTo: 2_000_000, rate: 0.0025 },
  { upTo: null, rate: 0.0015 },
];

export interface FeeBreakdown {
  /** База — сумма договора. */
  base: MoneyLike;
  /** Комиссия за заключение (null для free_c2c/excluded — блок не показывается). */
  fee: MoneyLike | null;
  /** К получению после тарифа оператора считается на платеже (Ф4), не здесь. */
  segment: ContractSegment;
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Комиссия по маржинальной шкале. Для бесплатных сегментов — null (ни слова о комиссии). */
export function computeContractFee(total: MoneyLike, segment: ContractSegment): MoneyLike | null {
  if (!hasContractFee(segment)) return null;
  const amount = Number(total.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { amount: '0.00', currency: total.currency };
  let fee = 0;
  let prev = 0;
  for (const tier of FEE_TIERS) {
    const cap = tier.upTo ?? Infinity;
    if (amount <= prev) break;
    const slice = Math.min(amount, cap) - prev;
    fee += slice * tier.rate;
    prev = cap;
    if (amount <= cap) break;
  }
  return { amount: round2(fee), currency: total.currency };
}

/** Полная раскладка «база → комиссия за заключение» для показа ДО подписания (§9.4). */
export function feeBreakdown(total: MoneyLike, segment: ContractSegment): FeeBreakdown {
  return { base: total, fee: computeContractFee(total, segment), segment };
}
