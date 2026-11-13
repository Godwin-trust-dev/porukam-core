import { test, expect } from '@playwright/test';

/**
 * DEV-15 §9/§10.1 — манифест, регистрация SW, офлайн-оболочка. Против `npm run preview:pwa`
 * (VITE_API_MODE=real, без MSW — см. playwright.pwa.config.ts и отчёт DEV-15 §1).
 */

test('манифест подключён и содержит установочные поля', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();

  const res = await page.request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();

  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toContain('src=pwa');
  expect(manifest.scope).toBe('/');
  expect(manifest.lang).toBe('ru');
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.some((i: { purpose?: string }) => (i.purpose ?? '').includes('maskable'))).toBe(true);
});

test('service worker регистрируется в production-сборке', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.getRegistrations().then((regs) => regs.length > 0), {
    timeout: 15_000,
  });
  const count = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((regs) => regs.length));
  expect(count).toBeGreaterThan(0);
});

test('оболочка открывается офлайн (навигационный fallback из precache, §1/§10.1)', async ({ page, context }) => {
  await page.goto('/');
  // Первая загрузка ставит и активирует SW, но НЕ контролирует текущую страницу (стандартный
  // жизненный цикл SW) — контроль начинается со следующей навигации, поэтому reload ниже
  // обязателен и для «активации», и для проверки офлайн-fallback за один проход.
  await page.evaluate(() => navigator.serviceWorker.ready);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('body')).not.toContainText('ERR_INTERNET_DISCONNECTED');

  await context.setOffline(false);
});

test('worker MSW не попадает в precache боевой сборки', async ({ page }) => {
  // `public/mockServiceWorker.js` нужен только мок-режиму, но лежит в public/ и потому
  // копировался в dist ЛЮБОЙ сборки, а под `globPatterns: **/*.js` ещё и попадал в
  // precache-манифест — worker MSW скачивался и кэшировался каждым пользователем прода
  // (репо-ADR-150, хвост §7). Лечение: `globIgnores` + удаление файла из dist для
  // не-мок-сборок (web/vite.config.ts, dropMockServiceWorker).
  //
  // Проверяется здесь ТОЛЬКО отсутствие в precache. Запрос самого файла проверять в этом
  // наборе бессмысленно: сьют гоняется против `vite preview`, а тот раздаёт `public/`
  // ПОВЕРХ `dist` и отдаёт 200 даже когда файла в `dist` уже нет (проверено эмпирически
  // 01.09). В проде такого слоя нет — nginx раздаёт только скопированный в образ `dist`
  // (конфиг nginx), поэтому там файл просто отсутствует.
  await page.goto('/');
  const sw = await page.request.get('/sw.js');
  expect(sw.ok()).toBeTruthy();
  expect(await sw.text()).not.toContain('mockServiceWorker');
});
