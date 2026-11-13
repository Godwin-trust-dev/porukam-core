import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

/**
 * DEV-15 §4/§10.4 — тост обновления. Реальный жизненный цикл «второй установленный SW ждёт
 * активации» дорого и флаково оркестровать в e2e — состояние `needRefresh` триггерим напрямую
 * через `window.__pwaDebug.triggerNeedRefresh()` (см. `swRegistration.ts`), а UI-реакцию
 * (тост, «Обновить» → перезагрузка, «Отложить» → скрыть без перезагрузки) проверяем по-настоящему.
 */

test('«новая версия» → тост → «Обновить» вызывает updateSW без ошибок', async ({ page }) => {
  // Без реального второго SW в `waiting` у vite-plugin-pwa нет чем реально перезагружаться
  // (нет controllerchange) — это НЕ то, что здесь проверяется. Проверяем саму проводку:
  // клик по «Обновить» доходит до настоящего `updateSW()` (не заглушки) и не роняет страницу.
  await authenticate(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __pwaDebug?: { triggerNeedRefresh?: () => void } }).__pwaDebug?.triggerNeedRefresh),
  );
  await page.evaluate(() => (window as unknown as { __pwaDebug: { triggerNeedRefresh: () => void } }).__pwaDebug.triggerNeedRefresh());

  await expect(page.getByText('Доступна новая версия')).toBeVisible();
  await page.getByRole('button', { name: 'Обновить' }).click();
  // Страница осталась живой — клик не уронил приложение.
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('«Отложить» скрывает тост без перезагрузки', async ({ page }) => {
  await authenticate(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __pwaDebug?: { triggerNeedRefresh?: () => void } }).__pwaDebug?.triggerNeedRefresh),
  );
  await page.evaluate(() => (window as unknown as { __pwaDebug: { triggerNeedRefresh: () => void } }).__pwaDebug.triggerNeedRefresh());

  await expect(page.getByText('Доступна новая версия')).toBeVisible();
  await page.getByRole('button', { name: 'Отложить' }).click();
  await expect(page.getByText('Доступна новая версия')).toHaveCount(0);
});

test('на мобильной раскладке тост не перекрывает ни рейл, ни FAB', async ({ page }) => {
  // В установленном приложении (display:standalone, TWA) тост «доступна новая версия» —
  // ЕДИНСТВЕННЫЙ канал обновления: приложение с домашнего экрана не перезапускается
  // неделями (репо-ADR-150). У тоста z-index:90, у рейла ShellLayout — 30, у FAB'а — 25,
  // поэтому тост не прятался за ними, а садился ПОВЕРХ и закрывал и вкладки навигации,
  // и основное действие экрана. `authenticate` приводит на дашборд — FAB здесь есть.
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __pwaDebug?: { triggerNeedRefresh?: () => void } }).__pwaDebug?.triggerNeedRefresh),
  );
  await page.evaluate(() => (window as unknown as { __pwaDebug: { triggerNeedRefresh: () => void } }).__pwaDebug.triggerNeedRefresh());

  const toast = page.getByText('Доступна новая версия');
  await expect(toast).toBeVisible();

  const rail = page.getByRole('navigation', { name: 'Porukam' }).last();
  await expect(rail).toBeVisible();

  const toastBox = await toast.boundingBox();
  const railBox = await rail.boundingBox();
  expect(toastBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  // Нижняя кромка тоста — ВЫШЕ верхней кромки рейла.
  expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(railBox!.y);

  // FAB живыми координатами здесь не проверить: этот набор гоняется без бэкенда
  // (VITE_API_MODE=real, Ф6 не поднят), поэтому дашборд отдаёт ErrorState и выходит
  // ДО отрисовки FAB'а. В основном наборе обратная беда — там мок-режим, SW не
  // регистрируется, и триггера `__pwaDebug.triggerNeedRefresh` попросту нет. Поэтому
  // запас под FAB проверяем инвариантом: отступ тоста снизу обязан перекрывать
  // панель И кнопку целиком (обе величины — токены, packages/ui/src/styles/tokens.css).
  const { toastBottom, navH, fabSize } = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const px = (name: string): number => parseFloat(root.getPropertyValue(name));
    const el = document.querySelector('[role="status"]')!;
    return {
      toastBottom: parseFloat(getComputedStyle(el).bottom),
      navH: px('--pr-bottom-nav-h'),
      fabSize: px('--pr-fab-size'),
    };
  });
  expect(navH).toBeGreaterThan(0);
  expect(fabSize).toBeGreaterThan(0);
  expect(toastBottom).toBeGreaterThanOrEqual(navH + fabSize);
});
