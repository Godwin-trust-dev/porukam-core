import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-04 · Приёмка этапа + церемония «Принято» — критерии приёмки §9.
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

/**
 * Переход по маршруту без полной перезагрузки страницы: `page.goto()` сбросил бы
 * in-memory сессию (§13.2 ТЗ — access-токен не персистится). Пункт приёмки этапа
 * пока не связан ссылкой с дашбордом (вне скоупа DEV-04) — открываем URL напрямую,
 * через popstate, который слушает React Router.
 */
async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('все пункты приняты → «Принять этап» → церемония → возврат (приёмка 1)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9001/milestones/ms-9001/accept');

  const checklist = page.getByTestId('acceptance-checklist');
  await expect(checklist).toBeVisible();
  for (const radio of await checklist.getByRole('radio', { name: 'Принять' }).all()) {
    await radio.click();
  }

  const acceptBtn = page.getByTestId('accept-milestone');
  await expect(acceptBtn).toBeEnabled();
  await acceptBtn.click();
  await page.getByTestId('confirm-accept').click();

  await expect(page.getByText('Этап принят — по рукам!')).toBeVisible();
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(page).toHaveURL(/\/contracts\/c-9001$/);
});

test('«Замечание» требует файл/описание и меняет кнопку на «Вернуть с замечаниями» (приёмка 2, 3)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9001/milestones/ms-9001/accept');

  const checklist = page.getByTestId('acceptance-checklist');
  const remarkRadios = checklist.getByRole('radio', { name: 'Замечание' });
  await remarkRadios.first().click();

  // Нельзя вернуть без пункта, доказательства и описания.
  await expect(page.getByTestId('return-milestone')).toBeDisabled();

  await page.getByLabel('Опишите замечание').fill('Плинтус не закреплён в углу');
  await expect(page.getByTestId('return-milestone')).toBeDisabled();

  await page.getByLabel('Приложить файл').setInputFiles({
    name: 'фото-угол.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('fake-image'),
  });

  // Остальные пункты чек-листа ещё не решены — кнопка появляется, но недоступна.
  await expect(page.getByTestId('return-milestone')).toBeDisabled();

  // Только оставшиеся пункты — клик по «Принять» первого пункта вернул бы его из «Замечание».
  const acceptRadios = checklist.getByRole('radio', { name: 'Принять' });
  const count = await acceptRadios.count();
  for (let i = 1; i < count; i++) await acceptRadios.nth(i).click();

  await expect(page.getByTestId('return-milestone')).toBeEnabled();
  await page.getByTestId('return-milestone').click();
  await expect(page.getByText('Возвращено с замечаниями')).toBeVisible();
});

test('«ожидаем сдачу» показывает срок и «Написать в чат» (приёмка 4)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9002/milestones/ms-9002/accept');

  await expect(page.getByText('Осталось 2 дней')).toBeVisible();
  await page.getByRole('button', { name: 'Написать в чат' }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test('искра — только в церемонии «Принято» (приёмка 5)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-9001/milestones/ms-9001/accept');

  // Искра (Spark) — img-роль с aria-label заголовка церемонии; до церемонии её нет.
  await expect(page.getByRole('img', { name: 'Этап принят — по рукам!' })).toHaveCount(0);

  const checklist = page.getByTestId('acceptance-checklist');
  // Ждём чек-лист ПЕРЕД перебором: `.all()` не ждёт появления элементов и на
  // непрорисованном списке молча возвращает пустой массив — тогда ни один
  // пункт не принят, «Принять этап» остаётся заблокированной, и падение
  // выглядит как таймаут клика, а не как гонка. Тест приёмки 1 выше ждёт
  // так же — здесь ожидание просто забыли, из-за чего тест падал только
  // под нагрузкой полного прогона.
  await expect(checklist).toBeVisible();
  for (const radio of await checklist.getByRole('radio', { name: 'Принять' }).all()) {
    await radio.click();
  }
  const acceptBtn = page.getByTestId('accept-milestone');
  await expect(acceptBtn).toBeEnabled();
  await acceptBtn.click();
  await page.getByTestId('confirm-accept').click();

  await expect(page.getByRole('img', { name: 'Этап принят — по рукам!' })).toBeVisible();
});
