import type { LocaleInfo } from '@porukam/core';
import { bundledLocaleInfos } from './bundledLocales';

/**
 * Бандл-локали (docs/tasks/Задача_fix_web-locales-switcher.md §4.2) —
 * используются, когда `GET /v1/locales` недоступен (ошибка сети/сервера) или
 * вернул пустой список: переключатель и `useLocaleResolution` остаются
 * рабочими вместо белого экрана/пустого списка/принудительного отката на `en`
 * независимо от языка браузера.
 *
 * Раньше здесь были захардкожены en/ru — единственные языки, реально
 * забандленные на той волне. Теперь список берётся из реестра пакетов
 * (`bundledLocaleInfos`, 29 языков): при мёртвом эндпоинте человек всё равно
 * получает свой язык, если перевод в сборке есть — правило §0
 * (docs/tasks/Задача_feat_l10n-launch-surfaces.md) не должно зависеть от
 * доступности справочника.
 */
export const FALLBACK_LOCALES: LocaleInfo[] = bundledLocaleInfos();
