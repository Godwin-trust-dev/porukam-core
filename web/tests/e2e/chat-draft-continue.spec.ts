import { test, expect, type Page } from '@playwright/test';

/**
 * Замечание владельца 06.09: «договор из чата создаётся с проблемами — не
 * подтянул ничего из черновика, даже контрагента». Чат-запрос создаёт
 * ЧЕРНОВИК договора (тип, роль, контрагент); из треда теперь ведёт кнопка
 * «Оформить договор» в мастер К ЭТОМУ черновику, а шаг «Стороны» показывает
 * контрагента, который уже стоит на договоре.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

test('чат-запрос → «Оформить договор» → мастер видит контрагента черновика', async ({ page }) => {
  await login(page);

  // Чат-запрос: контрагент из поиска + тип «Услуга» + шаблон сообщения.
  await page.goto('/chat/new');
  await page.getByTestId('inquiry-search').fill('Артём');
  await page.getByTestId('inquiry-results').getByText('Артём Половцев').click();
  await page.getByText('Услуга', { exact: true }).first().click();
  await expect(page.getByTestId('inquiry-submit')).toBeEnabled();
  await page.getByTestId('inquiry-submit').click();
  await expect(page).toHaveURL(/\/chat(\?sel=|\/)/);

  // В треде черновика — кнопка в мастер к этому же черновику.
  const cta = page.getByTestId('chat-draft-continue');
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page).toHaveURL(/\/contracts\/new\/details\?draft=/);

  // Шаг «Стороны» — кнопкой «Назад» внутри SPA (перезагрузка страницы
  // обнулила бы мок-базу с только что созданным черновиком).
  // Контрагент черновика подставлен: в моке черновик всегда получает
  // контрагента pf-mock-contractor-1 с карточкой репутации.
  await page.getByTestId('wizard-back').click();
  await expect(page).toHaveURL(/\/contracts\/new\/parties/);
  await expect(page.getByText('Марат Отделкин')).toBeVisible();
  await expect(page.getByText('@marat_otdelkin')).toBeVisible();
  await expect(page.getByText('Контрагент уже указан в черновике')).toHaveCount(0);

  // «Далее» без повторного выбора — на шаг «Суть» того же черновика.
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page).toHaveURL(/\/contracts\/new\/details/);
});
