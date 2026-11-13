import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-02 · Профиль владельца и настройки — критерии приёмки §9/§10.
 */

async function login(page: Page): Promise<void> {
  // Прямая навигация на /login (не через '/'): `RequireAuth` уводит с '/' на
  // /welcome (Google, GLOBAL-волна) — приём dashboard.spec.ts/smoke.spec.ts.
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

async function goToMe(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Профиль' }).first().click();
  await expect(page).toHaveURL(/\/me$/);
}

test('/me показывает паспорт без баннера под ним; шкала/бейдж верификации спрятаны (§9.1, отсмотр 2026-08-19, финал доска A)', async ({ page }) => {
  await login(page);
  await goToMe(page);

  await expect(page.getByText('Годвин').first()).toBeVisible();
  await expect(page.getByText('@godwin')).toBeVisible();
  // Отсмотр 2026-08-19: «Верификация N / 3» и «Базовая верификация» скрыты,
  // пока верификация не станет содержательной.
  await expect(page.getByText(/Верификация \d \/ 3/)).toHaveCount(0);
  await expect(page.getByText('Базовая верификация')).toHaveCount(0);
  // Отсмотр 2026-08-21: «верификацию через Госуслуги прячь» — ЕСИА-предложение
  // выключено флагом ESIA_VERIFICATION_ENABLED до реальной интеграции
  // (OwnerProfilePage), маршрут /me/verify/esica и код целы. NextStepSlot из-за
  // этого показывает не ЕСИА, а ближайшее важное уведомление (DEV-14).
  await expect(page.getByText('Авторизуйтесь через Госуслуги')).toHaveCount(0);
  // Замечание владельца 03.09 (финал доска A): большого баннера «важное
  // уведомление» под шапкой профиля нет — важное живёт в ленте, а на
  // плитке «Уведомл.» стоит счётчик.
  await expect(page.getByText('Срок приёмки этапа истекает через 2 часа')).toHaveCount(0);
  await expect(page.getByTestId('me-actions')).toBeVisible();
  await expect(page.getByTestId('me-menu')).toBeVisible();
});

test('слот исчезает при уровне 3 без важных уведомлений (§9.2)', async ({ page }) => {
  await login(page);

  // ЕСИА-флоу — заглушка (§11), реального пути дойти до уровня 3 через UI нет.
  // Используем e2e-хук мок-слоя (mocks/browser.ts) — без сети, тот же in-memory стор.
  await page.evaluate(() => {
    const debug = (window as unknown as { __mockDebug: { setVerificationLevel: (l: number) => void; clearImportantNotifications: () => void } }).__mockDebug;
    debug.setVerificationLevel(3);
    debug.clearImportantNotifications();
  });

  await goToMe(page);

  await expect(page.getByText('Авторизуйтесь через Госуслуги')).toHaveCount(0);
  // Проверяем ИМЕННО тот заголовок, который слот показывает в первом тесте:
  // прежняя строка («Договор ждёт вашей подписи») в слоте не появлялась
  // никогда — уведомление-дедлайн новее и `find` берёт его, так что проверка
  // проходила вхолостую и исчезновение слота не доказывала.
  await expect(page.getByText('Срок приёмки этапа истекает через 2 часа')).toHaveCount(0);
});

test('смена настройки приватности сохраняется в моке (§9.3)', async ({ page }) => {
  await login(page);
  await goToMe(page);
  await page.getByText('Настройки').click();
  await expect(page).toHaveURL(/\/me\/settings\/profile/);

  await page.getByTestId('settings-nav-privacy').click();
  await expect(page).toHaveURL(/\/me\/settings\/privacy/);

  const findableRow = page.getByText('Находимость по телефону').locator('xpath=../..');
  await expect(findableRow.getByText('Вкл')).toBeVisible();
  await findableRow.getByRole('switch').click();
  await expect(findableRow.getByText('Выкл')).toBeVisible();

  // Уходим на другой раздел и возвращаемся — состояние должно быть персистентно (мок PATCH).
  await page.getByTestId('settings-nav-notifications').click();
  await expect(page).toHaveURL(/\/me\/settings\/notifications/);
  await page.getByTestId('settings-nav-privacy').click();
  await expect(page).toHaveURL(/\/me\/settings\/privacy/);

  const findableRowAgain = page.getByText('Находимость по телефону').locator('xpath=../..');
  await expect(findableRowAgain.getByText('Выкл')).toBeVisible();
});

test('«Удалить аккаунт» доступен на mobile и открывает честный экран (§9.4)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await goToMe(page);
  await page.getByText('Настройки').click();
  // Замечание владельца 01.09: на телефоне `/me/settings` — ХАБ разделов
  // строками, а не редирект в первый раздел с полосой вкладок вбок.
  await expect(page).toHaveURL(/\/me\/settings$/);

  await page.getByTestId('settings-hub-account').click();
  await expect(page).toHaveURL(/\/me\/settings\/account/);

  const deleteRow = page.getByRole('button', { name: 'Удалить аккаунт' });
  await expect(deleteRow).toBeVisible();
  await deleteRow.click();

  await expect(page).toHaveURL(/\/me\/settings\/account\/delete/);
  await expect(page.getByText('Удаление аккаунта')).toBeVisible();
  // Текст экрана очищен от внутренних терминов (уборка ADR из локалей 05.09):
  // человеку — «ключи шифрования уничтожаются», а не «crypto-shredding».
  await expect(page.getByText(/ключи шифрования уничтожаются/)).toBeVisible();
  await expect(page.getByText(/доказательная цепочка сохраняются/)).toBeVisible();
});

test('смена @handle показывает «занят/свободно» (§9.5)', async ({ page }) => {
  await login(page);
  await goToMe(page);
  await page.getByText('Настройки').click();
  await expect(page).toHaveURL(/\/me\/settings\/profile/);

  const handleInput = page.getByLabel('Хендл');
  await handleInput.fill('@akovalev');
  await expect(page.getByTestId('handle-availability')).toHaveText('Занят', { timeout: 5_000 });

  await handleInput.fill('@brandnewhandle1');
  await expect(page.getByTestId('handle-availability')).toHaveText('Свободен', { timeout: 5_000 });
});

test('«Как гость» → полоса предпросмотра возвращает в профиль (замечание владельца 05.09)', async ({ page }) => {
  // «При просмотре своей карточки „как гость“ на десктопе не понятно как
  // вернуться обратно» — публичная карточка идёт вне оболочки, ни меню, ни
  // «назад» на ней нет. Полный круг: /me → карточка → обратно /me.
  await login(page);
  await goToMe(page);

  await page.getByRole('button', { name: 'Как гость' }).click();
  await expect(page).toHaveURL(/\/@godwin$/);

  const bar = page.getByTestId('preview-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByText('Вы смотрите свою карточку как гость')).toBeVisible();

  await page.getByTestId('preview-bar-back').click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByTestId('me-actions')).toBeVisible();
});

// 360px — самый узкий заявленный экран: если липкость держит здесь, держит везде.
test.describe('предпросмотр на узком экране', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('полоса предпросмотра остаётся видимой после скролла карточки (моб./десктоп — одно решение)', async ({ page }) => {
    await login(page);
    await goToMe(page);
    await page.getByRole('button', { name: 'Как гость' }).click();
    await expect(page.getByTestId('preview-bar')).toBeVisible();

    // Полоса липкая: после прокрутки вниз выход из режима всё ещё на экране —
    // поэтому дубля кнопки в действиях шапки карточки нет.
    await page.mouse.wheel(0, 1200);
    await expect(page.getByTestId('preview-bar-back')).toBeInViewport();
    // exact — иначе подстрока совпала бы с «Вернуться в профиль» в самой полосе.
    await expect(page.getByRole('button', { name: 'В профиль', exact: true })).toHaveCount(0);
  });
});

/**
 * Вход в приватный разбор своей репутации (ADR-163 §8): отдельный экран
 * владельца, а не кнопка на публичной карточке.
 */
test('/me → «Ваша репутация · Insights» открывает приватный разбор с блоком скрытого', async ({ page }) => {
  await login(page);
  await goToMe(page);

  await page.getByTestId('link-reputation-insights').click();
  await expect(page).toHaveURL(/\/me\/reputation$/);

  // Разбор метрик и подсказка зоны.
  await expect(page.getByTestId('insights-metrics')).toBeVisible();
  await expect(page.getByText('Сделано в срок · как исполнитель')).toBeVisible();

  // ЕДИНСТВЕННОЕ место в продукте, где видны объём и защищённые платежи.
  const hidden = page.getByTestId('insights-hidden');
  await expect(hidden).toBeVisible();
  await expect(hidden).toContainText('4820000.00 RUB');
  await expect(hidden).toContainText('12 из 45 сделок с защищённым платежом');
  // Заголовок раздела живёт над поверхностью (SectionLabel), не внутри неё.
  await expect(page.getByText('Считается, но не показывается другим')).toBeVisible();
});

test('на 360 разбор репутации не даёт горизонтального скролла + снимки 360/1280', async ({ page }) => {
  await login(page);
  await goToMe(page);
  await page.getByTestId('link-reputation-insights').click();
  await expect(page.getByTestId('insights-metrics')).toBeVisible();

  const dir = new URL('../../../screenshots/', import.meta.url).pathname;
  await page.setViewportSize({ width: 360, height: 900 });
  await expect(page.getByTestId('insights-metrics')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'разбор репутации на 360 — горизонтальный скролл').toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${dir}reputation-insights-360.png`, fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId('insights-metrics')).toBeVisible();
  await page.screenshot({ path: `${dir}reputation-insights-1280.png`, fullPage: true });
});
