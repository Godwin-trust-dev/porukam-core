/**
 * RTL-фундамент (DEV-16 §6). Языки с письмом справа-налево — статический список
 * (не зависит от `/v1/locales`, который может быть недоступен для гостя до первой
 * загрузки). Сами RTL-языки пока НЕ включены в переключателе (`enabled: false`
 * в моке `/v1/locales`, см. DEV-16a) — список здесь только определяет, ЧТО значит
 * «эта локаль — RTL», когда придёт волна B3.
 */
const RTL_LOCALES = new Set(['ar', 'fa', 'he', 'ur', 'dv']);

export function dirForLocale(code: string): 'ltr' | 'rtl' {
  const lang = code.split('-')[0]?.toLowerCase() ?? code;
  return RTL_LOCALES.has(lang) ? 'rtl' : 'ltr';
}
