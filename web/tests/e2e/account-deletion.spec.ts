import { test, expect } from '@playwright/test';

/**
 * Удаление аккаунта (ADR-169) — два требования Google Play к приложению с
 * аккаунтами, обе проверки здесь:
 *  1) ПУБЛИЧНАЯ страница-инструкция, открывающаяся без входа;
 *  2) рабочее удаление ИЗ приложения.
 */

test.describe('Публичная страница /legal/account-deletion', () => {
  test('открывается БЕЗ входа — никакого редиректа на /welcome', async ({ page }) => {
    await page.goto('/legal/account-deletion');

    // Главное в этом тесте: адрес НЕ подменён экраном входа. Именно так по
    // ссылке зайдёт проверяющий из Google — у него нет и не будет аккаунта.
    await expect(page).toHaveURL(/\/legal\/account-deletion$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Porukam');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Удаление аккаунта');

    // Пошаговая инструкция (четыре шага) и оба обязательных подраздела.
    await expect(page.getByRole('listitem')).toHaveCount(4);
    await expect(page.getByRole('heading', { name: 'Что удаляется сразу и безвозвратно' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Что сохраняется и на какой срок' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'hello@trust-dev.com' })).toBeVisible();
  });

  test('на 360px читается: заголовок виден, горизонтальной прокрутки нет', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/legal/account-deletion');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test('удаление аккаунта из настроек уводит на экран входа с уведомлением', async ({ page }) => {
  // Вход по OTP — тот же путь, что в smoke.spec.ts (мок-режим сборки).
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

  await page.goto('/me/settings/account/delete');
  // Ссылка на публичную инструкцию должна быть и здесь — человек имеет право
  // прочитать последствия, не выходя из флоу.
  await expect(page.getByRole('link', { name: 'Что удаляется и что сохраняется' })).toBeVisible();

  await page.getByTestId('delete-continue').click();
  await expect(page.getByTestId('delete-submit')).toBeDisabled();
  await page.getByTestId('delete-word').fill('УДАЛИТЬ');
  await page.getByTestId('delete-submit').click();

  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByText('Аккаунт удалён')).toBeVisible();
});
