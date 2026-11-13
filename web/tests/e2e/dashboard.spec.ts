import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-03 · Дашборд (рабочий стол) — ADR-090: минимальный дашборд запуска.
 * `pf-person-1` (актёр по умолчанию после входа) — 2 pending signature-
 * запроса (`sr-1`/`sr-3`, side=customer) + 1 in_progress лист (`ms-3`,
 * contractor) в `realContractsDb.ts` — три пункта «внимания», микс сторон.
 */

async function login(page: Page): Promise<void> {
  // Прямая навигация на /login (не через '/'): `RequireAuth` уводит с '/' на
  // /welcome (Google, GLOBAL-волна) — /login отдельный прямой маршрут, тот же
  // приём, что smoke.spec.ts.
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

test('«/» открывает дашборд — «внимание» + превью «мои сделки»', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Требует внимания сейчас')).toBeVisible();
  await expect(page.getByTestId('dashboard-attention')).toBeVisible();
  await expect(page.getByTestId('dashboard-contracts')).toBeVisible();
});

test('бренд в шапке — ссылка на главную (отсмотр 2026-08-18 №7)', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page).toHaveURL(/\/contracts$/);
  await page.getByTestId('brand-home').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('dashboard-attention')).toBeVisible();
});

test('«внимание» — микс сторон, четыре пункта (2 подписи + сдача + приёмка)', async ({ page }) => {
  await login(page);

  const attention = page.getByTestId('dashboard-attention');
  await expect(attention.getByText('Заказчик').first()).toBeVisible();
  await expect(attention.getByText('Исполнитель').first()).toBeVisible();
  // sr-1/sr-3 (подписи, customer) + ms-3 in_progress (сдача, contractor)
  // + ms-review-1 under_acceptance (приёмка, customer — сид rc-signed-review-1
  // из среза приёмки; тест не был обновлён вместе с сидом).
  await expect(attention.getByRole('button')).toHaveCount(4);
});

test('карточка подписи ведёт на страницу подписания договора', async ({ page }) => {
  await login(page);

  const attention = page.getByTestId('dashboard-attention');
  await attention.getByRole('button', { name: 'Подписать' }).first().click();
  await expect(page).toHaveURL(/\/contracts\/.+\/sign$/);
});

test('«Все сделки» ведёт на полный список (превью ограничен, у pf-person-1 семь сделок)', async ({ page }) => {
  await login(page);

  await expect(page.getByTestId('dashboard-contracts')).toBeVisible();
  await page.getByRole('button', { name: 'Все сделки' }).click();
  await expect(page).toHaveURL(/\/contracts$/);
});

/**
 * Решение владельца 05.09: счётчики «Активные»/«Архив» в денежной рамке —
 * кликабельные входы на соответствующую вкладку «Сделок». Вкладку выбирает
 * `?tab=` (`ContractsListPage`), «активные» — состояние по умолчанию.
 */
test('счётчик «Архив» в денежной рамке открывает «Сделки» на вкладке архива', async ({ page }) => {
  await login(page);

  await page.getByRole('link', { name: 'Архив', exact: true }).click();
  await expect(page).toHaveURL(/\/contracts\?tab=archive$/);
  // Вкладка не просто в адресе — она реально выбрана в полосе вкладок.
  await expect(page.getByRole('tab', { name: /Архив/ })).toHaveAttribute('aria-selected', 'true');
});

test('счётчик «Активные» открывает «Сделки» на вкладке по умолчанию', async ({ page }) => {
  await login(page);

  await page.getByRole('link', { name: 'Активные', exact: true }).click();
  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByRole('tab', { name: /Активные/ })).toHaveAttribute('aria-selected', 'true');
});

test('счётчики достижимы с клавиатуры — Enter на «Архиве» уводит на вкладку архива', async ({ page }) => {
  await login(page);

  const archive = page.getByRole('link', { name: 'Архив', exact: true });
  await archive.focus();
  await expect(archive).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/contracts\?tab=archive$/);
});
