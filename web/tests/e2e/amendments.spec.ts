import { test, expect, type Page } from '@playwright/test';

/**
 * ADR-161 · Вкладка «Допсоглашения» на карточке ПОДПИСАННОГО договора:
 * создать черновик → отредактировать → удалить → создать снова → отправить
 * на согласование. Подписанный договор в прогоне не «делается» — берём сид
 * `rc-progress-1` (в браузере тот же MSW-мок, что в vitest), где Годвин
 * (`u-1001`) исполнитель.
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

test('допсоглашения: черновик заводится, правится, удаляется и уходит на согласование', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-progress-1#amendments');

  const list = page.getByTestId('real-amendments');
  await expect(list).toBeVisible({ timeout: 15_000 });

  // --- создать черновик ---------------------------------------------------
  await page.getByRole('button', { name: 'Создать допник' }).click();
  await page.getByTestId('amendment-form-reason').fill('Перенос срока по второму этапу');
  await page.getByTestId('amendment-save-draft').click();
  await expect(list).toContainText('Перенос срока по второму этапу', { timeout: 15_000 });

  // --- открыть его и отредактировать --------------------------------------
  await list.getByRole('button', { name: /Перенос срока по второму этапу/ }).click();
  await expect(page.getByTestId('amendment-title')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('amendment-edit').click();
  await page.getByTestId('amendment-form-reason').fill('Перенос срока и уточнение объёма');
  await page.getByTestId('amendment-save-draft').click();
  await expect(page.getByTestId('amendment-form-reason')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Перенос срока и уточнение объёма')).toBeVisible();

  // --- удалить черновик ---------------------------------------------------
  await page.getByTestId('amendment-delete').click();
  await page.getByTestId('amendment-delete-confirm').click();
  // Удаление возвращает на карточку договора, сразу на вкладку допников.
  await expect(page.getByTestId('real-amendments')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('real-amendments')).not.toContainText('Перенос срока и уточнение объёма');

  // --- создать заново и сразу отправить на согласование --------------------
  await page.getByRole('button', { name: 'Создать допник' }).click();
  await page.getByTestId('amendment-form-reason').fill('Итоговая правка условий');
  await page.getByTestId('amendment-save-and-send').click();

  const row = page.getByTestId('real-amendments').getByRole('button', { name: /Итоговая правка условий/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // Отправленный допник виден второй стороне — черновик до этого был виден
  // только автору (ADR-161 §3); статус на строке это и показывает.
  await expect(row).toContainText('На согласовании');
});
