import { test, expect } from '@playwright/test';
import { authenticate, openPath } from './helpers';

/** DEV-15 §2/§10.2 — установка: Android/Chromium `beforeinstallprompt`, iOS-инструкция, standalone. */

test('beforeinstallprompt → баннер → «Установить» → prompt() вызван', async ({ page }) => {
  await authenticate(page);
  await page.evaluate(() => {
    (window as unknown as { __installPromptCalls: number }).__installPromptCalls = 0;
    const evt = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt?: () => Promise<void>;
      userChoice?: Promise<{ outcome: string; platform: string }>;
    };
    evt.prompt = () => {
      (window as unknown as { __installPromptCalls: number }).__installPromptCalls += 1;
      return Promise.resolve();
    };
    evt.userChoice = Promise.resolve({ outcome: 'accepted', platform: '' });
    window.dispatchEvent(evt);
  });

  // Баннер — «не на загрузке» (PwaSurfaces.tsx): ждёт первую смену маршрута.
  await openPath(page, '/contracts');

  await expect(page.getByText(/Установите Porukam на телефон/)).toBeVisible();
  await page.getByRole('button', { name: 'Установить' }).click();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __installPromptCalls: number }).__installPromptCalls))
    .toBe(1);
});

test('appinstalled прячет баннер насовсем — в настройках «Установлено»', async ({ page }) => {
  await authenticate(page);
  await page.evaluate(() => {
    const evt = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt?: () => Promise<void>;
      userChoice?: Promise<{ outcome: string; platform: string }>;
    };
    evt.prompt = () => Promise.resolve();
    evt.userChoice = Promise.resolve({ outcome: 'accepted', platform: '' });
    window.dispatchEvent(evt);
  });
  await openPath(page, '/contracts');
  await expect(page.getByText(/Установите Porukam на телефон/)).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.getByText(/Установите Porukam на телефон/)).toHaveCount(0);

  await openPath(page, '/me/settings/app');
  await expect(page.getByText('Установлено')).toBeVisible();
});

test('standalone (уже установлено) — install-точки скрыты', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const result = original(query);
      if (query.includes('display-mode: standalone')) Object.defineProperty(result, 'matches', { get: () => true });
      return result;
    };
  });
  await authenticate(page);
  await openPath(page, '/me/settings/app');

  await expect(page.getByText('Установлено')).toBeVisible();
  await expect(page.getByRole('button', { name: /Установить приложение/ })).toHaveCount(0);
});

/**
 * 05.09 — «✕» на баннере ОТКЛАДЫВАЕТ предложение на неделю (раньше отменяло навсегда), а
 * браузер без `beforeinstallprompt` (Samsung Internet) получает инструкцию по меню, а не
 * молчащую кнопку. Дальше — сценарии этого решения.
 */
const DISMISSED_AT_KEY = 'porukam.installBannerDismissedAt';
const DAY_MS = 24 * 60 * 60 * 1000;

test('«✕» на баннере — записывает отметку времени, а не флаг «навсегда»', async ({ page }) => {
  await authenticate(page);
  await openPath(page, '/contracts');
  await expect(page.getByText(/Установите Porukam на телефон/)).toBeVisible();

  await page.getByRole('button', { name: 'Скрыть' }).click();
  await expect(page.getByText(/Установите Porukam на телефон/)).toHaveCount(0);

  const stored = await page.evaluate((atKey) => ({
    at: Number(localStorage.getItem(atKey)),
    legacy: localStorage.getItem('porukam.installBannerDismissed'),
  }), DISMISSED_AT_KEY);
  expect(stored.legacy).toBeNull();
  expect(Math.abs(Date.now() - stored.at)).toBeLessThan(60_000);
});

test('отложено 3 дня назад — баннера нет', async ({ page }) => {
  await page.addInitScript(
    ([atKey, at]) => localStorage.setItem(String(atKey), String(at)),
    [DISMISSED_AT_KEY, Date.now() - 3 * DAY_MS] as [string, number],
  );
  await authenticate(page);
  await openPath(page, '/contracts');

  await expect(page.getByText(/Установите Porukam на телефон/)).toHaveCount(0);
});

test('отложено 8 дней назад — предложение установки вернулось', async ({ page }) => {
  await page.addInitScript(
    ([atKey, at]) => localStorage.setItem(String(atKey), String(at)),
    [DISMISSED_AT_KEY, Date.now() - 8 * DAY_MS] as [string, number],
  );
  await authenticate(page);
  await openPath(page, '/contracts');

  await expect(page.getByText(/Установите Porukam на телефон/)).toBeVisible();
});

test('браузер не дал beforeinstallprompt — «Установить» открывает инструкцию по меню браузера', async ({ page }) => {
  // Headless Chromium системный промпт не шлёт — ровно случай Samsung Internet у владельца.
  await authenticate(page);
  await openPath(page, '/contracts');

  await expect(page.getByText(/Установите Porukam на телефон/)).toBeVisible();
  await page.getByRole('button', { name: 'Установить' }).click();

  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('Как установить приложение');
  await expect(sheet).toContainText('Samsung Internet');
});

test('настройки без промпта — строка «Установить приложение» открывает ту же инструкцию', async ({ page }) => {
  await authenticate(page);
  await openPath(page, '/me/settings/app');

  await page.getByRole('button', { name: /Установить приложение/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Как установить приложение');
});

test('iOS UA — инструкция «На экран „Домой"» вместо системного промпта', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    });
  });
  await authenticate(page);
  await openPath(page, '/contracts');

  await expect(page.getByText(/Установите Porukam на телефон/)).toBeVisible();
  await page.getByRole('button', { name: 'Установить' }).click();
  await expect(page.getByRole('dialog')).toContainText('Установка на экран «Домой»');
});
