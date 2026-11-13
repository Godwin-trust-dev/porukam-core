import { matchBundledLocale } from '@porukam/i18n';
import { parsePublicPath } from '../publicSite/pages';
import { useGuestLocaleStore } from './localeStore';

/**
 * Язык ПЕРВОГО кадра (docs/tasks/Задача_feat_l10n-launch-surfaces.md §0):
 * язык из адреса публичной страницы → выбор гостя из сессии → язык браузера → `en`.
 *
 * Адрес стоит первым из-за публичного контура (ADR-195): `/ru/faq` — это и есть
 * русская версия страницы, её HTML пререндерен по-русски и проиндексирован как
 * русский. Если бы первый кадр считался по языку браузера, человек по ссылке
 * `/ru/faq` из браузера с `Accept-Language: de` увидел бы немецкий текст на
 * русском URL, а через миг — ещё и расхождение с `<html lang>`.
 *
 * Зачем отдельно от `useLocaleResolution`: тот хук резолвит язык в эффекте,
 * после ответа `GET /v1/locales` — то есть первый кадр рисуется языком,
 * заданным при создании инстанса. До этой ветки там стояло жёсткое
 * `createI18n('ru')`, и гость из Испании видел /welcome сначала по-русски,
 * потом (после резолюции) по-испански. Правило §0 — «каждое слово на языке
 * пользователя» — начинается с первого кадра, а не со второго.
 *
 * Считается по СТАТИЧЕСКОМУ реестру пакетов, без сети: список включённых
 * языков в этот момент ещё неизвестен, и ждать его — значит вернуть ту же
 * задержку. Если язык окажется выключен продуктово, `useLocaleResolution`
 * поправит выбор и покажет тост — как и для любого другого источника языка.
 *
 * `en` (а не `ru`) как последний фолбэк: ровно то, к чему приходит
 * `detectGuestLocale` для языка вне реестра — иначе первый кадр и результат
 * резолюции расходились бы гарантированно.
 */
export function initialLocale(
  navigatorLanguage: string | undefined = navigator.language,
  pathname: string = typeof window === 'undefined' ? '/' : window.location.pathname,
): string {
  const guest = useGuestLocaleStore.getState().locale;
  const fromPath = parsePublicPath(pathname)?.locale;
  return (
    matchBundledLocale(fromPath) ?? matchBundledLocale(guest) ?? matchBundledLocale(navigatorLanguage) ?? 'en'
  );
}
