import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-12 · Экспорт архива сделки — критерии приёмки §9 на контракте
 * `apps.archive` (ADR-139, DEV-12 §12): два артефакта (пакет/файлы), PDF —
 * «скоро», ссылки сторон, сроки хранения (ADR-137 §9).
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

test('закрытый: автоэкспорт «выдан при завершении сделки», Собрать заново → генерация → готово → пакет + файлы (сценарий 1)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9301/archive');

  await expect(page.getByTestId('archive-header')).toContainText('№ 2026-0301');
  await expect(page.getByTestId('export-row').first()).toContainText('Выдан при завершении сделки');
  await expect(page.getByTestId('download-package')).toHaveAttribute('href', /\/a\//);
  await expect(page.getByTestId('download-files')).toBeVisible();
  await expect(page.getByTestId('format-pdf')).toContainText('Скоро');
  await expect(page.getByTestId('download-pdf')).toHaveCount(0);

  const cta = page.getByTestId('export-cta');
  await expect(cta).toContainText('Собрать заново');
  await cta.click();

  await expect(page.getByTestId('generating-state')).toBeVisible();
  await expect(page.getByTestId('export-row')).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId('export-row').first()).toHaveAttribute('data-status', 'ready', { timeout: 10_000 });
  await expect(page.getByTestId('download-package')).toBeVisible();
});

test('shredded: файлы удалены по сроку — дата и «пакет с хешами по-прежнему доступен» (сценарий 2)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9302/archive');

  await expect(page.getByTestId('artifact-files')).toHaveAttribute('data-state', 'shredded');
  await expect(page.getByTestId('artifact-files')).toContainText('Пакет с хешами по-прежнему доступен');
  await expect(page.getByTestId('download-files')).toHaveCount(0);
  await expect(page.getByTestId('download-package')).toBeVisible();
});

test('ссылки сторон: своя копируется и отзывается с подтверждением, чужая — без адреса (сценарий 2а)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9301/archive');

  const mine = page.locator('[data-testid="archive-link"][data-mine="true"]');
  const other = page.locator('[data-testid="archive-link"][data-mine="false"]');
  await expect(mine).toHaveCount(2);
  await expect(other).toHaveCount(2);
  await expect(other.first().getByTestId('archive-link-url')).toHaveCount(0);
  // Отсмотр 03.09 «ссылки сторон не кликабельные»: свой адрес — настоящая
  // ссылка `<a href download>`, а не текст в <code> (ArchiveLinks.tsx).
  const mineUrl = mine.first().getByTestId('archive-link-url');
  await expect(mineUrl).toHaveAttribute('href', /\/a\//);
  await expect(mineUrl).toHaveAttribute('download', '');

  await mine.first().getByTestId('archive-link-revoke').click();
  await page.getByTestId('archive-link-revoke-confirm').click();
  await expect(page.locator('[data-testid="archive-link"][data-revoked="true"]')).toHaveCount(1);
});

test('in_work → пометка снимка в превью и на кнопке «Собрать снимок» (сценарий 3)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9303/archive');

  await expect(page.getByTestId('snapshot-note')).toContainText('снимком');
  await expect(page.getByTestId('export-cta')).toContainText('Собрать снимок');
});

test('черновик без заморозки → пусто (сценарий 4)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9304/archive');

  await expect(page.getByText('Пока нечего собирать')).toBeVisible();
  await expect(page.getByTestId('export-cta')).toHaveCount(0);
});

test('обе роли видят одинаковый пакет — симметрия (сценарий 5)', async ({ page }) => {
  await login(page);
  // Переключатель роли живёт на карточке договора (глобальный demo-стор, §8.5 п.3) — используем
  // существующий договор c-4001 только чтобы его нажать, дальше идём на архив другой сделки.
  await openPath(page, '/contracts/c-4001/overview');
  const customerPreview = await (async () => {
    await openPath(page, '/contracts/c-9301/archive');
    return page.getByTestId('package-preview').textContent();
  })();

  await openPath(page, '/contracts/c-4001/overview');
  await page.getByTestId('viewas-contractor').click();
  await openPath(page, '/contracts/c-9301/archive');
  const contractorPreview = await page.getByTestId('package-preview').textContent();

  expect(contractorPreview).toBe(customerPreview);
});

test('нет тарифов/пейвола и Drive; сроки хранения показаны (ADR-137 §9) (сценарий 7)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9301/archive');
  await expect(page.getByTestId('archive-header')).toBeVisible();

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/тариф|подписк|платный экспорт|Drive/i);
  await expect(page.getByTestId('archive-retention')).toBeVisible();
  await expect(page.getByTestId('retention-notice')).toBeVisible();
});
