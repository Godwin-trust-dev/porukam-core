import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-07 · Платёж (СБП) + План расчётов — критерии приёмки §9.
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

async function viewAsContractor(page: Page, contractId: string): Promise<void> {
  await openPath(page, `/contracts/${contractId}/overview`);
  await page.getByTestId('viewas-contractor').click();
}

test('заказчик: план → «Оплатить» → раскладка → СБП → авто-succeeded → успех без искры (приёмка 1)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-5001/money');

  await page.getByTestId(/^pay-stage-/).click();
  await expect(page.getByTestId('payment-hero')).toBeVisible();
  await expect(page.getByText('Платежи — без комиссии')).toBeVisible();

  await page.getByTestId('payment-method-sbp').click();
  await page.getByTestId('pay-submit').click();

  await expect(page.getByTestId('sbp-pay')).toBeVisible();
  await expect(page.getByText('Ожидаем подтверждение банка')).toBeVisible();

  // Sweep-on-read доводит pending → succeeded сам по себе (провайдер, без клика пользователя).
  await expect(page.getByTestId('payment-result')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('Переведено')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Переведено' })).toHaveCount(0);
});

test('наличные: получатель «Подтверждаю получение» → этап оплачен (приёмка 2)', async ({ page }) => {
  await login(page);
  await viewAsContractor(page, 'c-5002');
  await openPath(page, '/contracts/c-5002/payments/pay-cash-demo');

  await expect(page.getByTestId('cash-confirm')).toBeVisible();
  await page.getByTestId('confirm-receipt').click();

  await expect(page.getByTestId('payment-result')).toBeVisible();
  await expect(page.getByText('Переведено')).toBeVisible();
});

test('нигде нет «Отменить отметку»; спор не откатывает отметки (приёмка 3)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-5002/payments/pay-cash-demo');

  await expect(page.getByTestId('cash-confirm')).toBeVisible();
  await expect(page.getByRole('button', { name: /Отменить/i })).toHaveCount(0);

  await page.getByTestId('dispute-link').click();
  await expect(page.getByText(/Передали в спор/)).toBeVisible();
});

test('получатель видит «переведено» (не «поступит») (приёмка 4)', async ({ page }) => {
  await login(page);
  await viewAsContractor(page, 'c-5002');
  await openPath(page, '/contracts/c-5002/payments/pay-cash-demo');

  await expect(page.getByText(/поступит/)).toHaveCount(0);
  await page.getByTestId('confirm-receipt').click();
  await expect(page.getByText('Переведено')).toBeVisible();
  await expect(page.getByText(/поступит/)).toHaveCount(0);
});

test('политика без онлайн-провайдера → только наличные, без переключателя (приёмка 5, 6)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-5005/money');

  await page.getByTestId(/^pay-stage-/).click();
  await expect(page.getByTestId('payment-method-single')).toBeVisible();
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
  await expect(page.getByTestId('payment-method-sbp')).toHaveCount(0);
});

test('failed → «Повторить» ведёт обратно на выбор способа (демо-состояния мока)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-5002/payments/pay-failed-demo');

  await expect(page.getByText('Платёж не прошёл')).toBeVisible();
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByTestId('payment-hero')).toBeVisible();
});

/**
 * Реальный контур, предоплата (ADR-151/155): счёт по листу выставлен с
 * подписания и подписан СРОКОМ («К оплате до старта этапа»), а не видом
 * платежа — вид один, срок несёт `Contract.payment_order`.
 */
test('предоплата: счёт по листу виден до старта этапа и назван сроком (ADR-155)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-prepay-1/stages/ms-prepay-1');

  const card = page.getByTestId('stage-payment-confirm');
  await expect(card.getByText('К оплате до старта этапа')).toBeVisible();
  await expect(card.getByText(/оплата до начала этапа/)).toBeVisible();
  // Предоплатный счёт — условие гейта, отмена его заперла бы старт навсегда.
  await expect(card.getByTestId('payment-cancel')).toHaveCount(0);
});
