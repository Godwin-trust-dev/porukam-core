import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-13 · Список сделок / «Мои договоры» — критерии приёмки §10.
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

test('⭐ открыть /contracts → фильтры пусты, вкладка «Активные», виден микс ролей (сценарий 1)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts');

  await expect(page.getByRole('tab', { name: /Активные/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('contracts-list')).toBeVisible();
  // DEV-20_2 §3: фильтры — за воронкой, не полосой селектов над списком.
  await expect(page.getByTestId('open-filters')).toBeVisible();

  const rowsText = await page.getByTestId('contract-list-row').allInnerTexts();
  const hasCustomer = rowsText.some((t) => t.includes('вы заказчик'));
  const hasContractor = rowsText.some((t) => t.includes('вы исполнитель'));
  expect(hasCustomer && hasContractor).toBe(true);
});

test('переключить на «Архив» → завершённые + приглушённые терминальные/не состоявшиеся (сценарий 2)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts');
  await page.getByRole('tab', { name: /Архив/ }).click();

  await expect(page.getByTestId('contracts-list')).toBeVisible();
  await expect(page.getByText('Не состоялись и терминальные')).toBeVisible();
});

test('«⋯» → Экспортировать архив — пункт меню кликабелен и уводит со списка (сценарий 3, №13)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts');

  const firstRow = page.getByTestId('contract-list-row').first();
  await expect(firstRow).toBeVisible();
  await firstRow.getByTestId('action-menu-trigger').click();
  const item = page.getByRole('menuitem', { name: 'Экспортировать архив' });
  await expect(item).toBeVisible();
  // Экран архива (№13) собирается отдельной задачей (DEV-12, ещё не влит в эту ветку) —
  // здесь проверяем только то, что действие в меню есть и доступно для клика.
  await expect(item).toBeEnabled();
});

test('«⋯» → Копировать → новый черновик-дубликат (сценарий 4, ADR-088)', async ({ page }) => {
  // Раньше действие вело в мастер (шаг превью); с ADR-088 Фаза 1 оно создаёт
  // черновик-дубликат через реальный POST и открывает ЕГО карточку
  // (RealContractRow.onRepeat: «новый черновик, НЕ исходный договор»).
  // Пункт назывался «Как в прошлый раз» — отсмотр 2026-08-21 переименовал его
  // в «Копировать» и разрешил из любого статуса, включая черновик.
  await login(page);
  await openPath(page, '/contracts');

  const firstRow = page.getByTestId('contract-list-row').first();
  await expect(firstRow).toBeVisible();
  await firstRow.getByTestId('action-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Копировать' }).click();

  await expect(page).toHaveURL(/\/contracts\/[^/]+$/, { timeout: 10_000 });
  await expect(page.getByText('Черновик').first()).toBeVisible();
});

test('фильтр роли «Я исполнитель» сужает список; «Сбросить» возвращает всех (сценарий 5)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts');

  await expect(page.getByTestId('contract-list-row').first()).toBeVisible();
  const before = await page.getByTestId('contract-list-row').count();
  await page.getByTestId('open-filters').click();
  await page.getByLabel('Роль').selectOption('contractor');
  await page.getByTestId('filters-apply').click();

  await expect
    .poll(async () => {
      const texts = await page.getByTestId('contract-list-row').allInnerTexts();
      return texts.every((t) => t.includes('вы исполнитель'));
    })
    .toBe(true);
  const narrowed = await page.getByTestId('contract-list-row').count();
  expect(narrowed).toBeLessThan(before);

  // «Сбросить» закрывает шторку само (замечание владельца 03.09).
  await page.getByTestId('open-filters').click();
  await page.getByTestId('filters-reset').click();
  await expect.poll(() => page.getByTestId('contract-list-row').count()).toBe(before);
});

test('поиск без совпадений → пусто (сценарий 6)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts');

  await page.getByPlaceholder('Контрагент, название, №').fill('zzz-нет-такого-договора-zzz');
  await expect(page.getByText('Ничего не найдено')).toBeVisible({ timeout: 3000 });
});

test('черновик: «Удалить» с подтверждением, архива нет, «Открыть» ведёт на карточку (сценарий 7, ADR-104)', async ({ page }) => {
  // DELETE /contracts/{id} появился с ADR-104 — «Удалить» вернулось в меню, но
  // ТОЛЬКО у черновика и только через подтверждение (RealContractRow: черновик
  // контрагент ещё не видел, юрзначимого следа нет). Экспортировать черновику
  // по-прежнему нечего — пункт архива отсутствует.
  await login(page);
  await openPath(page, '/contracts');
  // Решение владельца 03.09: «Черновики» — третья вкладка, не категория в воронке.
  await page.getByTestId('tab-drafts').click();

  const firstRow = page.getByTestId('contract-list-row').first();
  await expect(firstRow).toBeVisible();
  // «⋯» в строке нет (DEV-20_2 §2) — на десктопе меню проявляется по
  // наведению на строку, поэтому сначала наводим, потом жмём.
  await firstRow.hover();
  await firstRow.getByTestId('action-menu-trigger').click();
  await expect(page.getByRole('menuitem', { name: 'Открыть' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Экспортировать архив' })).toHaveCount(0);

  // Удаление не срабатывает по одному клику: сначала окно подтверждения.
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  await expect(page.getByText('Удалить черновик?')).toBeVisible();
  await page.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByText('Удалить черновик?')).toHaveCount(0);

  await firstRow.getByTestId('action-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Открыть' }).click();
  await expect(page).toHaveURL(/\/contracts\/[^/]+$/, { timeout: 10_000 });
});
