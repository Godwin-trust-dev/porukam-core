/**
 * Мок-каталог языков интерфейса — зеркало `GET /v1/locales` (реальный эндпоинт
 * существует с `fix/web-locales-switcher`, `backend/apps/l10n/api/views.py`).
 * Только языки, без флагов стран — язык ≠ страна.
 *
 * Источник списка — РЕЕСТР ПАКЕТОВ (`bundledLocaleInfos` → `LOCALE_REGISTRY`
 * из `@porukam/i18n`), а не отдельный рукописный массив, как было до
 * feat/l10n-launch-surfaces. Тогда мок перечислял 29 языков (демо-список
 * DEV-16a §3), из которых переведены были два, — то есть мок-режим
 * воспроизводил ровно то, что запрещает правило §0: язык выбирается,
 * интерфейс молча остаётся английским. Теперь мок физически не может
 * предложить язык, которого нет в сборке.
 *
 * `enabled` у всех `true` — по §C постановки язык включается по готовности
 * пакета, а реестр и есть «пакет готов». Сценарий «локаль выключена админом»
 * от этого не потерян: он проверяется подменой ответа эндпоинта в самом тесте
 * (`server.use(http.get('/v1/locales', …))`, web/tests/localeIntegration.test.tsx)
 * и фикстурами `packages/ui` — там это данные теста, а не состояние мока.
 *
 * Коды — как в языковых пакетах (`pt-BR`, `zh-Hans`), не огрублённые до
 * `pt`/`zh`: бэкенд отдаёт `Locale.code`, и мок обязан говорить на том же
 * языке кодов.
 */
import type { LocaleInfo } from '@porukam/core';
import { bundledLocaleInfos } from '../features/locale/bundledLocales';

export const locales: LocaleInfo[] = bundledLocaleInfos();

export function listLocales(): LocaleInfo[] {
  return locales;
}

export function findLocale(code: string): LocaleInfo | undefined {
  return locales.find((l) => l.code === code);
}
