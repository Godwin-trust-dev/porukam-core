import { test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../screenshots');

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL(/\/$/, { timeout: 10_000 });
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.waitForURL(/\/contracts$/);
  await page.getByTestId('contracts-list').waitFor();
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1320, height: 900 } });

  test('снимки desktop', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Номер телефона').waitFor();
    await page.screenshot({ path: join(DIR, '01-login-desktop.png') });

    await login(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(DIR, '02-deals-desktop.png') });

    // Переключатель актёра — открытое меню.
    await page.getByTestId('actor-trigger').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(DIR, '03-actor-switch.png') });
    await page.keyboard.press('Escape');

    // Навигация внутри SPA (без reload — токены в памяти, §13.2).
    await page.getByRole('link', { name: 'Профиль' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(DIR, '04-profile-desktop.png') });
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('снимки mobile', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(DIR, '05-deals-mobile.png') });
  });
});

/**
 * Полоса предпросмотра «как гость» (замечание владельца 05.09) — одно решение
 * на обе ширины: 1280 (десктоп) и 360 (узкий телефон, где полоса переносится
 * в две строки, а кнопка возврата остаётся у края под большим пальцем).
 */
async function openOwnPublicCard(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL(/\/$/, { timeout: 10_000 });
  // SPA-переход: токены живут в памяти вкладки, жёсткий goto сбросил бы вход.
  await page.getByRole('link', { name: 'Профиль' }).first().click();
  await page.waitForURL(/\/me$/);
  await page.getByRole('button', { name: 'Как гость' }).click();
  await page.waitForURL(/\/@godwin$/);
  await page.getByTestId('preview-bar').waitFor();
  await page.waitForTimeout(300);
}

test.describe('предпросмотр «как гость» · desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('снимок полосы предпросмотра 1280', async ({ page }) => {
    await openOwnPublicCard(page);
    await page.screenshot({ path: join(DIR, '15-guest-preview-desktop.png') });
  });
});

test.describe('предпросмотр «как гость» · mobile 360', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('снимок полосы предпросмотра 360', async ({ page }) => {
    await openOwnPublicCard(page);
    await page.screenshot({ path: join(DIR, '16-guest-preview-mobile.png') });
  });
});
