import type { LocaleInfo } from '@porukam/core';
import { LOCALE_REGISTRY } from '@porukam/i18n';

/**
 * Языки, чей перевод стартовых поверхностей ЕСТЬ в этой сборке фронта
 * (`LOCALE_REGISTRY` из `@porukam/i18n`), в шейпе `LocaleInfo` — том же, что
 * отдаёт `GET /v1/locales`.
 *
 * Один источник для двух потребителей — бандл-фолбэка (`fallbackLocales.ts`,
 * когда эндпоинт недоступен) и мок-каталога (`mocks/localesDb.ts`): пока
 * список был написан руками в каждом месте, мок предлагал 29 языков, реально
 * переведённых было два, а фолбэк знал про два — три разных ответа на один
 * вопрос «какие языки есть». Теперь ответ один и растёт вместе с реестром.
 *
 * `enabled: true` у всех: реестр — это и есть «пакет готов» (правило §C
 * постановки — включаем язык по готовности пакета). Продуктовый рубильник
 * `Locale.enabled` живёт на бэкенде и приходит в ответе эндпоинта; здесь его
 * подменять нечем, а выдавать бандл-язык за выключенный — врать.
 */
export function bundledLocaleInfos(): LocaleInfo[] {
  return LOCALE_REGISTRY.map((l) => ({
    code: l.code,
    self_name: l.selfName,
    english_name: l.englishName,
    quality: l.quality,
    enabled: true,
    dir: l.rtl ? 'rtl' : 'ltr',
  }));
}
