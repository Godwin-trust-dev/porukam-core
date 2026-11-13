import { test, expect, type Page } from '@playwright/test';

/** Ф2 acceptance: полный путь заключения договора для обоих сегментов на моках. */

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

/** Черновики этого сценария (contractsDb c-3001/c-3002) больше не приходят в
 * список «Мои договоры» — тот с ADR-088 читает реальный контур
 * (realContractsDb), а мок-FSM-сиды живут по прямому URL (как c-9001/c-9002
 * в acceptance.spec). Открываем карточку SPA-переходом по id — токены в
 * памяти, полный goto их сбросил бы (§13.2); прежний клик по строке списка
 * падал таймаутом («падает на чистом main», №12-класс из отчёта DEV-17). */
async function openContract(page: Page, id: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/contracts/${id}`);
  await page.getByTestId('send-contract').waitFor();
}

test('free_c2c: черновик → правка контрагента → приёмка → заморозка → две подписи → signed, без комиссии', async ({ page }) => {
  await login(page);
  await openContract(page, 'c-3001'); // «Сборка шкафа-купе»

  // Отправить на согласование
  await page.getByTestId('send-contract').click();
  await expect(page.getByText('Согласование', { exact: true }).first()).toBeVisible();

  // Контрагент предлагает правку
  await page.getByTestId('tab-nego').click();
  await page.getByTestId('viewas-contractor').click();
  await page.getByTestId('propose-revision').click();
  await page.getByLabel('Что меняем').fill('Срок сборки');
  await page.getByLabel('Было').fill('5 дней');
  await page.getByLabel('Стало').fill('7 дней');
  await page.getByTestId('submit-revision').click();

  // Заморозка невозможна с открытой правкой
  await page.getByTestId('tab-sign').click();
  await page.getByTestId('freeze').click();
  await expect(page.getByText(/открытые правки/i)).toBeVisible();

  // Заказчик принимает правку
  await page.getByTestId('tab-nego').click();
  await page.getByTestId('viewas-customer').click();
  await page.getByRole('button', { name: 'Принять', exact: true }).click();

  // Заморозка проходит
  await page.getByTestId('tab-sign').click();
  await page.getByTestId('freeze').click();
  await expect(page.getByTestId('integrity-hash')).toBeVisible();

  // Заключение договора бесплатно (финмодель v2) — для всех сегментов
  await expect(page.getByText('Заключение договора — бесплатно')).toBeVisible();

  // Резюме условий + запрос подписей
  await page.getByTestId('show-ai-summary').click();
  await page.getByTestId('request-signatures').click();

  // Две подписи
  await page.getByTestId('viewas-customer').click();
  await page.getByTestId('sign-customer').click();
  await page.getByTestId('viewas-contractor').click();
  await page.getByTestId('sign-contractor').click();

  await expect(page.getByText(/По рукам! Договор подписан/)).toBeVisible();
});

test('paid_business: реквизиты → заморозка → одна кнопка подписи у обеих сторон, без комиссии → signed', async ({ page }) => {
  await login(page);
  await openContract(page, 'c-3002'); // «Ремонт кухни „под ключ“»

  await page.getByTestId('send-contract').click();
  await page.getByTestId('tab-sign').click();

  // Заморозка требует реквизиты выплат (для приёма платежей, не для комиссии)
  await page.getByTestId('freeze').click();
  await expect(page.getByTestId('add-payout')).toBeVisible();
  await page.getByTestId('add-payout').click();
  // Дождаться, пока реквизиты привяжутся (плашка исчезнет), затем заморозка
  await expect(page.getByTestId('add-payout')).toBeHidden();
  await page.getByTestId('freeze').click();
  await expect(page.getByTestId('integrity-hash')).toBeVisible();

  // Заключение договора бесплатно — видно и в платном сегменте; шага оплаты комиссии нет
  await page.getByTestId('show-ai-summary').click();
  await expect(page.getByText('Заключение договора — бесплатно')).toBeVisible();
  await expect(page.getByTestId('simulate-fee-failure')).toHaveCount(0);
  await page.getByTestId('request-signatures').click();

  // Первая подпись
  await page.getByTestId('viewas-customer').click();
  await page.getByTestId('sign-customer').click();

  // Вторая подпись — сразу signed, без комиссии и без отказов оплаты
  await page.getByTestId('viewas-contractor').click();
  await page.getByTestId('sign-contractor').click();
  await expect(page.getByText(/По рукам! Договор подписан/)).toBeVisible();
});
