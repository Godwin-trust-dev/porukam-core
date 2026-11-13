import { useTranslation } from 'react-i18next';
import {
  formatMoney,
  formatPolicyMoney,
  formatDate,
  formatShortDate,
  formatDateTime,
  formatCountdown,
  formatRelativeTime,
  formatFileSize,
  type MoneyLike,
  type CurrencyPolicy,
  type DateFormatOptions,
} from '@porukam/core';

/**
 * DEV-16 §5 ⭐ — единственная точка форматирования дат/чисел/сумм в React-коде: все
 * хелперы `@porukam/core` уже принимают `locale`, здесь он всегда — активный язык
 * интерфейса (`i18n.language`), а не хардкод. Компоненты не вызывают `formatMoney`/
 * `formatDate` из `@porukam/core` напрямую и не форматируют руками (`toLocaleDateString`
 * и т.п.) — только через этот хук.
 */
export function useFormatters(): {
  formatMoney: (m: MoneyLike) => string;
  formatPolicyMoney: (m: MoneyLike, currency: CurrencyPolicy) => string;
  /** `{ legal: true }` — юрзначимая дата (срок договора, дата подписания/TSA, сроки приёмки-оплаты) → latn-цифры (DEV-16 §5). */
  formatDate: (iso: string, opts?: DateFormatOptions) => string;
  /** Короткая дата для СПИСКОВ («3 сен», «3 сен 2025» — если год другой). Не для юрзначимых дат. */
  formatShortDate: (iso: string) => string;
  formatDateTime: (iso: string, opts?: DateFormatOptions) => string;
  formatCountdown: (deadlineIso: string, nowMs: number) => string;
  formatRelativeTime: (iso: string, nowMs: number) => string;
  formatFileSize: (bytes: number) => string;
} {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  return {
    formatMoney: (m) => formatMoney(m, locale),
    formatPolicyMoney: (m, currency) => formatPolicyMoney(m, currency, locale),
    formatDate: (iso, opts) => formatDate(iso, locale, undefined, opts),
    formatShortDate: (iso) => formatShortDate(iso, locale),
    formatDateTime: (iso, opts) => formatDateTime(iso, locale, undefined, opts),
    formatCountdown: (deadlineIso, nowMs) => formatCountdown(deadlineIso, nowMs, locale),
    formatRelativeTime: (iso, nowMs) => formatRelativeTime(iso, nowMs, locale),
    formatFileSize: (bytes) => formatFileSize(bytes, locale),
  };
}
