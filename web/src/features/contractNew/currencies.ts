/**
 * Валюты мастера (отсмотр 2026-08-19): список расширен с «RUB/USD/EUR» до
 * валют рынков всех 29 языков интерфейса, а стартовое значение ПОДСКАЗЫВАЕТСЯ
 * языком интерфейса. Это UX-подсказка выбора, НЕ «валюта по умолчанию» в
 * домене (ADR-041/CLAUDE.md: в Money всегда уезжает явная валюта — поле
 * заполнено видимым значением, которое человек может сменить).
 */

export const WIZARD_CURRENCIES = [
  'RUB',
  'USD',
  'EUR',
  'AED',
  'AMD',
  'AZN',
  'BDT',
  'BRL',
  'CNY',
  'GBP',
  'GEL',
  'IDR',
  'ILS',
  'INR',
  'IRR',
  'JPY',
  'KES',
  'KRW',
  'KZT',
  'PKR',
  'PLN',
  'RON',
  'THB',
  'TRY',
  'UAH',
  'UZS',
  'VND',
] as const;

/** Язык интерфейса → валюта его основного рынка (все 29 локалей packages/i18n). */
const LOCALE_CURRENCY: Record<string, string> = {
  ru: 'RUB',
  en: 'USD',
  ar: 'AED',
  az: 'AZN',
  bn: 'BDT',
  de: 'EUR',
  es: 'EUR',
  fa: 'IRR',
  fr: 'EUR',
  he: 'ILS',
  hi: 'INR',
  hy: 'AMD',
  id: 'IDR',
  it: 'EUR',
  ja: 'JPY',
  ka: 'GEL',
  kk: 'KZT',
  ko: 'KRW',
  pl: 'PLN',
  'pt-BR': 'BRL',
  ro: 'RON',
  sw: 'KES',
  th: 'THB',
  tr: 'TRY',
  uk: 'UAH',
  ur: 'PKR',
  uz: 'UZS',
  vi: 'VND',
  'zh-Hans': 'CNY',
};

export function suggestedCurrencyForLocale(tag: string | undefined): string {
  if (!tag) return 'USD';
  if (LOCALE_CURRENCY[tag]) return LOCALE_CURRENCY[tag];
  const base = tag.split('-')[0] ?? '';
  return LOCALE_CURRENCY[base] ?? 'USD';
}
