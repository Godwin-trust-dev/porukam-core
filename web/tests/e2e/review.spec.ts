import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-10 · Согласование — протокол разногласий — критерии приёмки §9/§11.
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
  await openPath(page, `/contracts/${contractId}`);
  await page.getByTestId('viewas-contractor').click();
  await openPath(page, `/contracts/${contractId}/review`);
}

test('чужая мультивариант → «Выбрать вариант» → применено (приёмка 1)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-6001/review');

  const card = page.getByTestId('revision-card').filter({ hasText: 'Этап 3 · Чистовая отделка' });
  await expect(card).toBeVisible();
  await card.getByRole('radio', { name: /55 000/ }).click();

  await expect(card.getByText('принята')).toBeVisible();
  // Дерево этапов перерисовано с новой суммой (VariantPicker в карточке стал read-only).
  await expect(card.getByRole('radio', { checked: true })).toContainText('55 000');
});

test('Отклонить → подсветка → Встречная с 2 вариантами → исходная закрыта (приёмка 2)', async ({ page }) => {
  await login(page);
  await viewAsContractor(page, 'c-6001'); // «Этап 2» предложен заказчиком — чужая с точки зрения исполнителя.

  const card = page.getByTestId('revision-card').filter({ hasText: 'Этап 2 · Черновые работы' });
  await card.getByTestId('revision-reject').click();

  await expect(page.getByText('Может, предложите свою редакцию?')).toBeVisible();
  await page.getByTestId('reject-propose-counter').click();

  await page.getByTestId('variant-value-0').fill('44 000 ₽');
  await page.getByTestId('add-variant').click();
  await page.getByTestId('variant-value-1').fill('46 000 ₽');
  await page.getByTestId('revision-sheet-submit').click();

  await expect(card.getByText('закрыта встречной')).toBeVisible();
});

test('предодобренная альтернатива → «Принять в 1 клик» (приёмка 3)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-6001/review');

  const block = page.getByTestId('preapproved-block');
  await expect(block).toBeVisible();
  await block.getByRole('radio').first().click();
  await expect(page.getByTestId('preapproved-block')).toHaveCount(0);
});

test('accept-all с финансово значимыми → подтверждение суммы; многовариантная не входит (приёмка 4)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-6001/review');

  await page.getByTestId('accept-all').click();
  const changes = page.getByTestId('accept-all-changes');
  await expect(changes).toContainText('Демонтаж');
  await expect(changes).not.toContainText('Чистовая отделка');

  await page.getByTestId('confirm-accept-all').click();
  const card = page.getByTestId('revision-card').filter({ hasText: 'Демонтаж' });
  await expect(card.getByText('принята')).toBeVisible();
});

test('0 открытых правок → «Заморозить и подписать» → №5 (приёмка 5)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-6002/review');

  await expect(page.getByTestId('freeze')).toBeEnabled();
  await page.getByTestId('freeze').click();
  await expect(page).toHaveURL(/\/contracts\/c-6002\/sign$/);
});

test('отозвать договор — терминально, без влияния на репутацию (приёмка 6)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-6001/review');

  await page.getByTestId('review-withdraw').click();
  const terminalTitle = page.getByRole('heading', { name: 'Договор отозван инициатором' });
  await expect(terminalTitle).toBeVisible();
  await expect(page.getByText('не влияет на репутацию')).toBeVisible();
});

test('вход из №5 «Отклонить на доработку» → комментарий подписанта — правкой (приёмка 7)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-6005/review');

  const card = page.getByTestId('revision-card').filter({ hasText: 'Комментарий подписанта' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('розетк');
});

test('симметрия: своя правка контрагента показывает «Отозвать» после переключения роли (приёмка 8)', async ({ page }) => {
  await login(page);
  await viewAsContractor(page, 'c-6001');

  const card = page.getByTestId('revision-card').filter({ hasText: 'Этап 3 · Чистовая отделка' });
  await expect(card.getByText('Ожидает выбора контрагента')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Отозвать' })).toBeVisible();
});
