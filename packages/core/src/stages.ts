/**
 * DEV-09 §4.2 — авто-разнос суммы по этапам конструктора «Этапы» (StagesBuilder).
 * Доменная функция (не UI-математика в компоненте, ТЗ §2 п.«Компонент не считает деньги» —
 * тут именно тот единственный расчёт, который относится к конструктору, а не к бэкенду).
 */
import type { MoneyLike } from './money';

/**
 * Делит `total` на `n` равных частей той же валюты; остаток от округления (минорные
 * единицы) уходит в ПОСЛЕДНЮЮ часть — так сумма частей всегда точно равна total.
 */
export function distributeEvenly(total: MoneyLike, n: number, decimals = 2): MoneyLike[] {
  if (n <= 0) return [];
  const factor = 10 ** decimals;
  const minorTotal = BigInt(Math.round(Number(total.amount) * factor));
  const base = minorTotal / BigInt(n);
  const remainder = minorTotal - base * BigInt(n);
  const parts: bigint[] = Array.from({ length: n }, () => base);
  const last = parts.length - 1;
  parts[last] = (parts[last] ?? 0n) + remainder;
  return parts.map((p) => ({ amount: (Number(p) / factor).toFixed(decimals), currency: total.currency }));
}

/** Сумма списка (одна валюта — вызывающий отвечает за консистентность). */
export function sumMoney(items: MoneyLike[], currency: string, decimals = 2): MoneyLike {
  const factor = 10 ** decimals;
  const minor = items.reduce((s, m) => s + BigInt(Math.round(Number(m.amount) * factor)), 0n);
  return { amount: (Number(minor) / factor).toFixed(decimals), currency };
}

/**
 * DEV-09 §4.4 — `PaymentModal`: аванс/после-приёмки. Сумма этапа фиксирована, аванс
 * вводится суммой ИЛИ процентом — второе поле и проценты считаются автоматически.
 */
export function percentOfMoney(total: MoneyLike, percent: number, decimals = 2): MoneyLike {
  const value = (Number(total.amount) * percent) / 100;
  return { amount: value.toFixed(decimals), currency: total.currency };
}

/** Обратное преобразование: сколько процентов от total составляет part (округление до сотых процента). */
export function percentFromMoney(total: MoneyLike, part: MoneyLike): number {
  const t = Number(total.amount);
  if (!t) return 0;
  return Math.round((Number(part.amount) / t) * 10000) / 100;
}
