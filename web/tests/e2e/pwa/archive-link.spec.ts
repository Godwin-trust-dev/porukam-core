import { test, expect } from '@playwright/test';

/**
 * Инцидент 03.09 (docs/backlog.md, «03.09 вечер»): долгоживущая ссылка на архив
 * сделки `/a/<token>` (ADR-139 §7) при вставке в адресную строку «ничего не
 * делала». Причина — `navigateFallback` service worker'а: он подменял ЛЮБУЮ
 * навигацию оболочкой SPA из precache, и до nginx запрос не доходил вовсе
 * (по логам прода — ни одного `/a/`-запроса за 48 часов, при том что человек
 * пробовал). Лечение — денилист путей бэкенда
 * (`src/features/pwa/navigateFallbackDenylist.ts` → `vite.config.ts`).
 *
 * Проверка тут — единственная, которая ловит регрессию по-настоящему: `page.route`
 * перехватывает СЕТЕВОЙ слой, поэтому ответ из кэша SW до него не доходит. Если
 * денилист сломается, обработчик не вызовется и на странице окажется оболочка.
 */
test('service worker не подменяет /a/<token> оболочкой SPA — запрос уходит в сеть', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Контроль над fetch появляется только со СЛЕДУЮЩЕЙ навигации после установки
  // (обычный жизненный цикл SW) — без reload проверять было бы нечего.
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 15_000 });

  let networkHits = 0;
  // Бэкенда в этой сборке нет (VITE_API_MODE=real, но без core) — сам ответ
  // подделываем: важно НЕ содержимое, а сам факт выхода в сеть. Отдаём text/html,
  // а не application/zip: zip браузер увёл бы в скачивание, и проверять текст
  // страницы было бы нечем.
  await page.route('**/a/**', async (route) => {
    networkHits += 1;
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p>ARCHIVE-FROM-NETWORK</p>' });
  });

  await page.goto('/a/test-token');

  expect(networkHits).toBe(1);
  await expect(page.locator('body')).toContainText('ARCHIVE-FROM-NETWORK');
  // Контрольная проверка от ложноположительного результата: клиентский маршрут
  // по-прежнему обязан получать оболочку (иначе денилист слишком широкий).
  await expect(page.locator('#root')).toHaveCount(0);
});

test('клиентский маршрут по-прежнему отдаётся оболочкой SPA (денилист не задел SPA)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 15_000 });

  await page.goto('/contracts/c-1');
  await expect(page.locator('#root')).not.toBeEmpty();
});
