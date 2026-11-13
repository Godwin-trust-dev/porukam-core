import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-05 · Подписание договора + церемония «по рукам» — критерии приёмки §9/§10.
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

/** Переход без полной перезагрузки — иначе in-memory сессия (токен) сбросится (§13.2 ТЗ). */
async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * Переключатель «смотреть как контрагент» живёт только на карточке договора
 * (ContractDetailPage) — заходим туда, переключаем роль, возвращаемся на экран подписания.
 */
async function viewAsContractor(page: Page, contractId: string): Promise<void> {
  await openPath(page, `/contracts/${contractId}`);
  await page.getByTestId('viewas-contractor').click();
  await openPath(page, `/contracts/${contractId}/sign`);
}

test('заказчик C2C: «Подписать» → одна подпись → «ждём вторую»; обе → церемония (приёмка 1)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-3003/sign');

  await expect(page.getByTestId('sign-cta')).toBeVisible();
  await expect(page.getByTestId('commission-section')).toHaveCount(0);
  await page.getByTestId('sign-cta').click();
  await expect(page.getByText('Одна подпись есть — ждём вторую')).toBeVisible();

  // Демо-переключатель роли — «смотреть как контрагент», чтобы пройти вторую подпись в одной сессии.
  await viewAsContractor(page, 'c-3003');
  await page.getByTestId('sign-cta').click();

  await expect(page.getByText('По рукам!')).toBeVisible();
  await page.getByRole('button', { name: 'Открыть договор' }).click();
  await expect(page).toHaveURL(/\/contracts\/c-3003$/);
});

test('исполнитель-бизнес: одна кнопка «Подписать», комиссии нет → signed → церемония (приёмка 2, финмодель v2)', async ({ page }) => {
  await login(page);
  await viewAsContractor(page, 'c-3004');

  await expect(page.getByTestId('commission-section')).toHaveCount(0);
  await expect(page.getByTestId('go-pay-and-sign')).toHaveCount(0);
  await page.getByTestId('sign-cta').click();

  await expect(page.getByText('По рукам!')).toBeVisible();
});

test('заказчику не показывается CommissionSection даже на бывшем платном договоре (приёмка 4)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-3004/sign');

  await expect(page.getByText('Одна подпись есть — ждём вторую')).toBeVisible();
  await expect(page.getByTestId('commission-section')).toHaveCount(0);
});

test('«Заключение договора — бесплатно» видно обеим сторонам (финмодель v2, DEV-05-PATCH v2)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-3003/sign');
  await expect(page.getByText('Заключение договора — бесплатно')).toBeVisible();

  await viewAsContractor(page, 'c-3004');
  await expect(page.getByText('Заключение договора — бесплатно')).toBeVisible();
});

test('«Редактировать договор» доступен, пока не подписано обеими, и аннулирует подписи (приёмка 5)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-3003/sign');

  const editLink = page.getByTestId('edit-contract-link');
  await expect(editLink).toBeEnabled();
  await editLink.click();
  // DEV-10 §1/§6 — теперь ведёт на протокол разногласий (under_review), не на карточку договора.
  await expect(page).toHaveURL(/\/contracts\/c-3003\/review$/);
});

test('другая юрисдикция (DEV-05-PATCH §5): смена мок-политики меняет денежный копирайт без правок кода', async ({
  page,
}) => {
  await login(page);
  await openPath(page, '/contracts/c-3005/sign');

  await expect(page.getByText('Платежи — с комиссией за перевод')).toBeVisible();
  await expect(page.getByText('Платежи — без комиссии')).toHaveCount(0);
  await expect(page.getByTestId('commission-section')).toHaveCount(0);
});

test('искра — только в церемонии «по рукам» (приёмка 6)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-3003/sign');

  await expect(page.getByRole('img', { name: 'По рукам!' })).toHaveCount(0);

  await page.getByTestId('sign-cta').click();
  await viewAsContractor(page, 'c-3003');
  await page.getByTestId('sign-cta').click();

  await expect(page.getByRole('img', { name: 'По рукам!' })).toBeVisible();
});
