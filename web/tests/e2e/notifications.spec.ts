import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-14 · Уведомления — лента + push + email — критерии приёмки §10/§11.
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

test('лента → deep-link «Принять этап» ведёт на приёмку этапа — узкий экран (сценарий 1)', async ({ page }) => {
  // <1024 — мобильная стопка (DEV-19 §2): тап по пункту сразу уводит к месту события.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await openPath(page, '/notifications');

  // Финал доска A: слова-действия в строке нет — к месту события ведёт тап
  // по самому пункту.
  await page.getByText('Срок приёмки этапа истекает через 2 часа').first().click();
  await expect(page).toHaveURL(/\/contracts\/.+\/milestones\/.+\/accept/);
});

test('лента → «Принять этап» на десктопе: пункт раскрывается справа, действие — оттуда (сценарий 1, DEV-19 §2)', async ({ page }) => {
  // ≥1024 — master-detail: пункт ВЫБИРАЕТСЯ, не уводит со списка; к месту
  // события ведёт кнопка в колонке деталей (с тем же текстом действия).
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await openPath(page, '/notifications');

  await page.getByText('Срок приёмки этапа истекает через 2 часа').first().click();
  await expect(page).toHaveURL(/\/notifications\?.*sel=/);
  await expect(page.getByTestId('notification-detail-pane')).toBeVisible();

  await page.getByTestId('notification-pane-open').click();
  await expect(page).toHaveURL(/\/contracts\/.+\/milestones\/.+\/accept/);
});

test('«Прочитать все» — счётчик непрочитанных обнуляется (сценарий 2)', async ({ page }) => {
  await login(page);
  await openPath(page, '/notifications');

  const markAllBtn = page.getByRole('button', { name: 'Прочитать все' });
  await expect(markAllBtn).toBeEnabled();
  await markAllBtn.click();
  await expect(markAllBtn).toBeDisabled();
});

test('push из промо → запрос → granted → тумблер включён (сценарий 3)', async ({ page }) => {
  await login(page);
  await openPath(page, '/notifications');

  await expect(page.getByText('Разрешите отправлять уведомления, чтобы не пропустить сроки')).toBeVisible();
  await page.getByRole('button', { name: 'Включить' }).click();
  await expect(page.getByRole('dialog')).toContainText('Разрешите приложению отправлять уведомления');

  // Системный диалог — через CDP (эквивалент реального «Разрешить»), без слов «web»/«браузер» в UI.
  await page.context().grantPermissions(['notifications']);
  await page.getByRole('button', { name: 'Разрешить' }).click();

  await openPath(page, '/me/settings/notifications');
  await expect(page.getByRole('switch', { name: 'Push-уведомления' })).toHaveAttribute('aria-checked', 'true');
});

test('push denied устройством → честная подсказка, тумблер неактивен (сценарий 4)', async ({ page }) => {
  await login(page);
  await page.evaluate(() => {
    (window as unknown as { __mockDebug: { setPushPermission: (s: string) => void } }).__mockDebug.setPushPermission(
      'denied',
    );
  });

  await openPath(page, '/me/settings/notifications');
  await expect(page.getByText('Уведомления выключены в настройках устройства')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Push-уведомления' })).toBeDisabled();
});

test('фильтр «Непрочитанные» (сценарий 5)', async ({ page }) => {
  await login(page);
  await openPath(page, '/notifications');

  await page.getByRole('tab', { name: /Непрочитанные/ }).click();
  await expect(page).toHaveURL(/filter=unread/);
  await expect(page.getByText('Оплата этапа получена')).toHaveCount(0);
});

test('настройки: снять группу «Споры» — сохраняется (сценарий 6)', async ({ page }) => {
  await login(page);
  await openPath(page, '/me/settings/notifications');

  // «Споры» дублируется в сайдбаре (пункт навигации) — сужаем поиск до контента страницы.
  const disputesRow = page.locator('main').getByText('Споры').locator('xpath=../..');
  await expect(disputesRow.getByText('Вкл')).toBeVisible();
  await disputesRow.getByRole('switch').click();
  await expect(disputesRow.getByText('Выкл')).toBeVisible();

  await openPath(page, '/notifications');
  await openPath(page, '/me/settings/notifications');
  const disputesRowAgain = page.locator('main').getByText('Споры').locator('xpath=../..');
  await expect(disputesRowAgain.getByText('Выкл')).toBeVisible();
});

test('платформо-нейтральный копирайт — нет «web»/«браузер» в push-строках (сценарий 7)', async ({ page }) => {
  await login(page);
  await openPath(page, '/me/settings/notifications');
  const settingsText = await page.locator('body').innerText();
  expect(settingsText).not.toMatch(/браузер|\bweb\b/i);

  await openPath(page, '/notifications');
  const feedText = await page.locator('body').innerText();
  expect(feedText).not.toMatch(/браузер|\bweb\b/i);
});

/**
 * Решение владельца 05.09: «пусть штук 15 висят, далее кнопка "показать ещё".
 * а то список до бесконечности получился». В моке 22 пункта: 15 + «ещё 7».
 */
test('лента по 15 + «Показать ещё» — мобайл 360, кнопка во всю ширину и 44px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await login(page);
  await openPath(page, '/notifications');

  await expect(page.getByTestId('notification-item')).toHaveCount(15);

  const showMore = page.getByTestId('notifications-show-more');
  await expect(showMore).toHaveText('Показать ещё 7 уведомлений');
  const box = await showMore.boundingBox();
  expect(box).not.toBeNull();
  // §5.4 — тач-таргет ≥ 44px; на 360px кнопка занимает ширину колонки.
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThan(280);

  await showMore.click();

  await expect(page.getByTestId('notification-item')).toHaveCount(22);
  // Лента кончилась — кнопки больше нет.
  await expect(showMore).toHaveCount(0);
});

test('«Показать ещё» дописывает страницу вниз, не перематывая ленту', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await login(page);
  await openPath(page, '/notifications');

  const firstItem = page.getByTestId('notification-item').first();
  await expect(firstItem).toBeVisible();
  // Место пункта В ДОКУМЕНТЕ, а не во вьюпорте: клик по кнопке сам подкручивает
  // страницу, и координата относительно окна поменялась бы законно.
  const offsetInDocument = () => firstItem.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const before = await offsetInDocument();

  await page.getByTestId('notifications-show-more').click();
  await expect(page.getByTestId('notification-item')).toHaveCount(22);

  // Догрузка идёт ВНИЗ — верх ленты остался на том же месте, прыжка нет.
  expect(await offsetInDocument()).toBeCloseTo(before, 0);
});

/**
 * ADR-170 (владелец 07.09: «уведомление открывает общую вкладку сделки, и потом
 * допустим в правку надо искать»). Бэк отдаёт раздел якорем в `action.href`;
 * карточка обязана этот якорь понимать.
 */

test('лента доносит якорь раздела до адреса — тап ведёт не «в договор вообще»', async ({ page }) => {
  // <1024 — мобильная стопка: тап по пункту уводит сразу к месту события.
  // Договоры мок-ленты карточками не заведены (ссылки фикстур ведут на
  // приёмку/подписание), поэтому здесь проверяется, что якорь доезжает до
  // адреса; что по этому адресу открывается нужная вкладка — следующий тест.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await openPath(page, '/notifications');

  await page.getByText('Договор подписан обеими сторонами').first().click();
  await expect(page).toHaveURL(/\/contracts\/c-14002#negoSign$/);
});

test('якорь ссылки открывает раздел карточки без хождения по вкладкам', async ({ page }) => {
  await login(page);

  // «Переговоры и подписи» лежат ЗА строкой вкладок (пятая из восьми) — до
  // этой ветки путь туда был «шит фильтров → выбрать → применить».
  await openPath(page, '/contracts/rc-review-1#negoSign');
  await expect(page.getByTestId('real-propose-revision')).toBeVisible({ timeout: 15_000 });

  await openPath(page, '/contracts/rc-progress-1#payments');
  await expect(page.getByTestId('payments-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('tab-payments')).toHaveAttribute('aria-selected', 'true');
});

test('неизвестный якорь ничего не переключает — остаётся обзор', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-progress-1#whatever');
  await expect(page.getByTestId('tab-overview')).toHaveAttribute('aria-selected', 'true');
});
