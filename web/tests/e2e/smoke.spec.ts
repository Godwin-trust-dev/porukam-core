import { test, expect } from '@playwright/test';

/**
 * Playwright smoke (критерий приёмки 3, ТЗ §15):
 * вход по OTP → оболочка → список сделок → переключение актёра (на моках).
 */
test('вход по OTP → оболочка → сделки → смена актёра', async ({ page }) => {
  // Прямая навигация на /login (не через '/'): `RequireAuth` (GLOBAL-волна)
  // неавторизованных с '/' уводит на /welcome (Google), не /login — /login
  // остаётся отдельным прямым маршрутом при PHONE_LOGIN_ENABLED (дефолт вне
  // прод-сборки), не редиректом с корня.
  await page.goto('/login');

  // Шаг телефона: согласие юрканала + номер.
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();

  // Шаг кода: подсказка dev-кода и ввод 111111.
  await expect(page.getByText(/Тестовый режим/)).toBeVisible();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();

  // Оболочка + дашборд ролей (DEV-03 §1 — «/» после входа).
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await expect(page.getByTestId('dashboard-attention')).toBeVisible();

  // Список сделок доступен через навигацию.
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByTestId('contracts-list')).toBeVisible();
  // Реальный контур (ADR-088 Фаза 1, realContractsDb.ts) — заголовок без «под
  // ключ» (тот был из старого contractsListDb.ts, уже не обслуживает этот путь,
  // realContractsHandlers зарегистрирован раньше в handlers.ts).
  await expect(page.getByText('Ремонт ванной комнаты')).toBeVisible();

  // Переключение актёра меняет активный профиль в шапке.
  await page.getByTestId('actor-trigger').click();
  await page.getByTestId('actor-option-pf-biz-1').click();
  await expect(page.getByTestId('actor-active')).toContainText('Тёплый ремонт');

  // Список сделок остаётся доступен после смены актёра.
  await expect(page.getByTestId('contracts-list')).toBeVisible();
});
