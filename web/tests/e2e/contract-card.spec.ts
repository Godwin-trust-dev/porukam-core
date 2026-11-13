import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-06 · Карточка договора (Обзор + вкладки) — критерии приёмки §11.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('заказчик видит «Примите этап» + [Принять] → ведёт на приёмку (приёмка 1)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-4001/overview');

  await expect(page.getByText(/ждёт вашей приёмки/)).toBeVisible();
  await page.getByRole('button', { name: 'Принять' }).click();
  await expect(page).toHaveURL(/\/milestones\/.+\/accept$/);
});

test('исполнитель на том же договоре видит инфо-режим без кнопки принятия + [Напомнить] (приёмка 2)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-4001/overview');
  await page.getByTestId('viewas-contractor').click();

  await expect(page.getByText(/Ждём приёмку этапа/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Принять' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Напомнить' })).toBeVisible();
});

test('контент вкладок Этапы/Деньги/История идентичен у обеих ролей (приёмка 3)', async ({ page }) => {
  await login(page);

  await openPath(page, '/contracts/c-4001/stages');
  const customerStages = await page.getByTestId('stage-tree').textContent();

  await page.getByTestId('viewas-contractor').click();
  const contractorStages = await page.getByTestId('stage-tree').textContent();
  expect(customerStages).toBe(contractorStages);

  await openPath(page, '/contracts/c-4001/history');
  await expect(page.getByText('Допников пока нет')).toBeVisible();
});

test('деньги — универсальные подписи «Оплачено»/«Остаток» (приёмка 4)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-4001/money');

  await expect(page.getByText('Оплачено').first()).toBeVisible();
  await expect(page.getByText('Остаток')).toBeVisible();
  await expect(page.getByText('Получено')).toHaveCount(0);
  await expect(page.getByText('Ожидается')).toHaveCount(0);
});

test('клик по имени контрагента открывает его карточку (приёмка 5)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-4001/overview');

  await page.getByTestId('counterparty-link').click();
  await expect(page).toHaveURL(/\/@masterremont$/);
});

test('один статус-чип, не два (приёмка 6)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-4001/overview');

  await expect(page.getByTestId('contract-status')).toHaveCount(1);
});
