// Диапазон U+0300–U+036F combining diacritical marks — снять диакритику (é → e)
// после `normalize('NFD')`, для нечувствительного к акцентам поиска (DEV-16a §2).
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/**
 * Нормализация строки для подбора по вводу: без регистра и диакритики, без
 * краевых пробелов. Общая для LocaleList (поиск языка) и ChecklistEditor
 * (подбор критериев по набранному тексту) — одинаково работает для любой
 * из 29 локалей, включая письменности без регистра.
 *
 * `s` защищено от undefined/null (не строгий TS-контракт, а реальные ответы API —
 * docs/tasks/Задача_fix_web-locales-switcher.md: до фикса бэкенд не отдавал
 * self_name вовсе, и `undefined.normalize()` ронял весь список).
 */
export function normalizeForSearch(s: string | undefined | null): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '')
    .toLowerCase()
    .trim();
}
