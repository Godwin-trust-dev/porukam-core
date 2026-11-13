import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

/**
 * DEV-15 §3/§10.3 — полоса «нет сети». Чистая UI-реакция на `online`/`offline` (без SW) —
 * `context.setOffline` не всегда синхронно бьёт по DOM-событиям во всех движках, поэтому
 * дублируем явным `dispatchEvent`, как рекомендует сам `useNetworkStatus`.
 */

test('офлайн → полоса «Нет сети», онлайн → скрыта', async ({ page, context }) => {
  await authenticate(page);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/Нет сети/)).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/Нет сети/)).toHaveCount(0);
});
