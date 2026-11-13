import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-shell: переключатель актёра в шапке (личный аккаунт + организации).
 */
async function login(page: Page): Promise<void> {
  // Прямо на /login: гард неавторизованных теперь ведёт на /welcome
  // (GLOBAL-вход, Google) — телефонной формы там нет.
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

test('меню: личный аккаунт + организации; «Добавить организацию» скрыто фич-флагом', async ({ page }) => {
  await login(page);
  await page.getByTestId('actor-trigger').click();

  await expect(page.getByTestId('actor-option-pf-person-1')).toBeVisible();
  await expect(page.getByTestId('actor-option-pf-biz-1')).toBeVisible();
  await expect(page.getByTestId('actor-option-pf-biz-2')).toBeVisible();
  // Отсмотр 2026-08-22: «объединения — их нет и пока не будет, включим потом».
  // `organizations: false` (web/src/shared/features.ts) не передаёт onAddOrg —
  // без обработчика ActorSwitcher пункт вообще не рисует. Это проверка флага,
  // а не отсутствия функции: включат — тест обязан упасть и потребовать правки.
  await expect(page.getByTestId('actor-option-add-org')).toHaveCount(0);
});

test('смена актёра меняет контекст и не оставляет экран прежнего актёра', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByTestId('contracts-list').waitFor();

  // Открываем конкретную сделку — контекст, который не должен «протечь» на другого
  // актёра. Заголовок — реального контура (realContractsDb, без «под ключ»).
  // Прогон идёт на десктопной ширине (1280 по умолчанию), где клик по строке
  // ВЫБИРАЕТ сделку в master-detail (DEV-19 §2), а не уводит на её страницу —
  // поэтому на полную карточку заходим через «⋯ → Открыть» (этот пункт открывает
  // карточку на любой ширине).
  const row = page.getByTestId('contract-list-row').filter({ hasText: 'Ремонт ванной комнаты' });
  await row.getByTestId('action-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Открыть' }).click();
  await expect(page).toHaveURL(/\/contracts\//);

  await page.getByTestId('actor-trigger').click();
  await page.getByTestId('actor-option-pf-biz-2').click();

  // Ушли со страницы конкретной сделки на безопасный экран.
  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByTestId('actor-active')).toContainText('СтройБыт');

  // Список сделок остаётся доступен под новым актёром.
  await expect(page.getByTestId('contracts-list')).toBeVisible();
});

test('смена актёра снимает и ВЫБОР в master-detail, не только страницу сделки (DEV-19 §2)', async ({ page }) => {
  // Выбор живёт в URL (`?sel=`), поэтому он — такой же «контекст прежнего
  // актёра», как и открытая карточка: после переключения его не должно остаться,
  // иначе колонка деталей полезет за чужой сделкой.
  await login(page);
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByTestId('contracts-list').waitFor();

  await page.getByTestId('contract-list-row').first().click();
  await expect(page).toHaveURL(/\/contracts\?.*sel=/);
  await expect(page.getByTestId('contract-detail-pane')).toBeVisible();

  await page.getByTestId('actor-trigger').click();
  await page.getByTestId('actor-option-pf-biz-2').click();

  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByTestId('contract-detail-pane')).toHaveCount(0);
});

test('маршрут /organizations/new жив и показывает заглушку контура «Юрлица»', async ({ page }) => {
  // Вход из меню убран вместе с фич-флагом, но МАРШРУТ остаётся —
  // features.ts прямо это оговаривает: «прямая ссылка ведёт в заглушку
  // раздела». Проверяем то, что осталось правдой: по адресу — заглушка,
  // а не 404 и не пустой экран.
  await login(page);
  await page.goto('/organizations/new');

  await expect(page).toHaveURL(/\/organizations\/new/);
  await expect(page.getByText('Организации')).toBeVisible();
});

test('переключатель доступен с клавиатуры: стрелки + Enter выбирают, Esc закрывает', async ({ page }) => {
  await login(page);
  await page.getByTestId('actor-trigger').click();

  await page.keyboard.press('ArrowDown'); // личный → первая организация
  await page.keyboard.press('ArrowDown'); // → вторая организация
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('actor-active')).toContainText('СтройБыт');

  await page.getByTestId('actor-trigger').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(page.getByTestId('actor-trigger')).toBeFocused();
});
