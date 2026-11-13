import { test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../screenshots');

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL(/\/$/, { timeout: 10_000 });
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.waitForURL(/\/contracts$/);
  await page.getByTestId('contracts-list').waitFor();
}

test.describe('desktop Ф2', () => {
  test.use({ viewport: { width: 1320, height: 940 } });

  test('снимки договорного контура', async ({ page }) => {
    await login(page);

    // Мастер создания (DEV-09)
    await page.getByTestId('create-contract').click();
    await page.getByTestId('type-service').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(DIR, '08-contract-create.png') });

    // Открыть платный договор мок-FSM-контура (c-3002): в списке «Мои договоры»
    // его больше нет — тот читает реальный контур (ADR-088, realContractsDb),
    // мок-сиды открываются по прямому URL SPA-переходом (как в contract-flow.spec).
    await page.evaluate(() => {
      window.history.pushState({}, '', '/contracts/c-3002');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByTestId('send-contract').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(DIR, '09-contract-overview.png') });

    // Дерево этапов
    await page.getByTestId('tab-stages').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(DIR, '10-contract-stages.png') });

    // Заморозка → раскладка комиссии 1 020 ₽
    await page.getByTestId('tab-overview').click();
    await page.getByTestId('send-contract').click();
    await page.getByTestId('tab-sign').click();
    await page.getByTestId('freeze').click();
    await page.getByTestId('add-payout').click();
    await page.getByTestId('add-payout').waitFor({ state: 'hidden' });
    await page.getByTestId('freeze').click();
    await page.getByTestId('show-ai-summary').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(DIR, '11-contract-sign-fee.png') });

    // Две подписи → подписано
    await page.getByTestId('request-signatures').click();
    await page.getByTestId('viewas-customer').click();
    await page.getByTestId('sign-customer').click();
    await page.getByTestId('viewas-contractor').click();
    await page.getByTestId('sign-contractor').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(DIR, '12-contract-signed.png') });

    // История — DEV-20_2 §3: пятая вкладка карточки живёт в шите по воронке.
    await page.getByTestId('open-filters').click();
    await page.getByTestId('filters-category').selectOption('timeline');
    await page.getByTestId('filters-apply').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(DIR, '13-contract-timeline.png') });
  });
});

test.describe('mobile Ф2', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('снимок договора mobile', async ({ page }) => {
    await login(page);
    // См. комментарий в desktop-блоке: мок-FSM-сид открывается по прямому URL.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/contracts/c-3002');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByTestId('send-contract').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(DIR, '14-contract-mobile.png') });
  });
});
