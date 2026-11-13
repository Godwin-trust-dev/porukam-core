import { matchBundledLocale } from '@porukam/i18n';

/**
 * Автоопределение языка гостя (DEV-16a §3): `navigator.language` → код языка из
 * списка включённых → нет совпадения → `en`. Чистая функция — не зависит от
 * браузера напрямую (принимает язык параметром), юнит-тестируема без
 * jsdom/navigator-моков.
 *
 * Сопоставление тега с кодом — через `matchBundledLocale` (реестр пакетов), а не
 * срезанием региона, как было раньше (`'pt-BR'.split('-')[0] === 'pt'`): браузер
 * говорит `pt-BR`/`zh-CN`/`es-419`, а языковые пакеты называются
 * `pt-BR`/`zh-Hans`/`es`. Срезание региона отправляло бразильского и китайского
 * гостя в английский, хотя перевод для них есть — прямое нарушение §0
 * (docs/tasks/Задача_feat_l10n-launch-surfaces.md).
 *
 * `enabledCodes` решает последним: язык может быть в сборке, но выключен
 * продуктово (`Locale.enabled=false`) — тогда он не подходит. И наоборот, язык
 * из `enabledCodes`, которого нет в сборке, брать нельзя: интерфейс молча
 * отрендерился бы по EN-фолбэку, а человек считал бы, что видит перевод.
 */
export function detectGuestLocale(navigatorLanguage: string | undefined | null, enabledCodes: string[]): string {
  if (!navigatorLanguage) return 'en';
  const bundled = matchBundledLocale(navigatorLanguage);
  return bundled && enabledCodes.includes(bundled) ? bundled : 'en';
}
