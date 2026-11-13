/**
 * i18n-инициализация (ТЗ §14; JSON-пакеты и фолбэк-цепочка — DEV-16 §1).
 * Доменные `code` не локализуются — только человекочитаемые тексты.
 *
 * Источник строк — `src/locales/<code>/*.json`, по одному файлу на неймспейс (формат
 * совместим с внешним конвейером: языковые пакеты приходят готовыми JSON-файлами,
 * без ручной пересборки TS). `EN` — канонический язык: `fallbackLng: 'en'` — любой
 * недостающий ключ в любом языке (включая `ru`) рендерится по-английски, а не рушит
 * экран. Рантайм-язык первого кадра задаёт вызывающая сторона (`initialLocale()` в
 * `web/src/app/providers.tsx` — выбор гостя/язык браузера; раньше там стояло жёсткое
 * `'ru'`), и это НЕЗАВИСИМО от того, что является фолбэком.
 *
 * `en`/`ru` — статически в этом модуле; остальные 27 языков стартовых поверхностей
 * (ADR-089) подгружаются ленивым чанком через `loadLocaleResources` ниже.
 */
import i18n, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ru } from './locales/ru';
import { en } from './locales/en';
import { LAZY_LOCALE_LOADERS } from './locales/lazy';
import { pseudoize } from './pseudo';

// `en-XA`-подобная псевдолокаль (DEV-16 §1 ⭐ — «не ломается на длинных строках»).
// Считается один раз при загрузке модуля, не на каждый createI18n(). Не выбираема через
// обычный UI-переключатель (нет в /v1/locales) — только через e2e-хук
// `window.__mockDebug.setPseudoLocale()` (web/src/mocks/browser.ts).
const pseudoEn = pseudoize(en);

export const resources = {
  ru: { translation: ru },
  en: { translation: en },
  'en-XA': { translation: pseudoEn },
} as const;

export function createI18n(lng = 'ru'): I18nInstance {
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

/**
 * Догружает пакет языка в уже созданный инстанс i18n и говорит, есть ли этот
 * язык в сборке вообще (docs/tasks/Задача_feat_l10n-launch-surfaces.md §A).
 *
 * Вызывать ПЕРЕД `changeLanguage(code)`, а не после: иначе между сменой языка
 * и приходом чанка интерфейс успевает отрендериться по EN-фолбэку — то самое
 * «переведено, но молча по-английски», которое запрещает §0 постановки.
 *
 * Идемпотентна и дешева на повторных вызовах: языки основного бандла и уже
 * подгруженные отдают `true` сразу, без сети. `false` — языка в этой сборке
 * нет (вызывающая сторона решает свой фолбэк; для неизвестного кода i18next
 * и так отдал бы EN, но молча).
 */
export async function loadLocaleResources(instance: I18nInstance, code: string): Promise<boolean> {
  if (code in resources) return true;
  if (instance.hasResourceBundle(code, 'translation')) return true;

  const loader = LAZY_LOCALE_LOADERS[code];
  if (!loader) return false;

  const dict = await loader();
  // deep=true, overwrite=true — мерж вложенных неймспейсов (`contract.card`,
  // `contractNew.typeForm`), который не сносит уже лежащее.
  instance.addResourceBundle(code, 'translation', dict, true, true);
  return true;
}

export { ru };
export { en };
export type { RuDict } from './locales/ru';
export type { EnDict } from './locales/en';
export { UI_NAMESPACES } from './locales/ui';
export type { UiDict } from './locales/ui';
export {
  BUNDLED_LOCALE_CODES,
  EAGER_LOCALES,
  LOCALE_REGISTRY,
  localeMeta,
  matchBundledLocale,
} from './locales/registry';
export type { LocaleMeta } from './locales/registry';
export { useHtmlLangDir } from './useHtmlLangDir';
export { dirForLocale } from './dir';
export { pseudoize } from './pseudo';
