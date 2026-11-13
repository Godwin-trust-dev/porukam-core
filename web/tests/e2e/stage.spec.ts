import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-11 · Доказательства + формальная сдача этапа — критерии приёмки §9.
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

/** Переход без полной перезагрузки — сохраняет in-memory сессию (см. acceptance.spec.ts). */
async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function openAsPerformer(page: Page, path: string): Promise<void> {
  await openPath(page, path);
  const gateSwitch = page.getByRole('button', { name: 'Смотреть как исполнитель' });
  if (await gateSwitch.isVisible().catch(() => false)) {
    await gateSwitch.click();
  }
}

test('in_work без доказательств → «Сдать этап» доступна → подтверждение → under_acceptance + таймер (сценарий 1)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9101/stages/st-9101');

  const cta = page.getByTestId('submit-stage-cta');
  await expect(cta).toBeEnabled();
  await cta.click();
  await expect(page.getByText('Что произойдёт')).toBeVisible();
  await page.getByTestId('confirm-submit-stage').click();

  await expect(page.getByText(/до автоприёмки/)).toBeVisible();
});

/**
 * ADR-164 (жалоба владельца 05.09). Реальный контур: `rc-progress-1/ms-3` —
 * пункт чек-листа просит фото, файла нет. Раньше сдача упиралась в 422 со
 * служебным текстом про UUID; теперь пункт помечен, диалог предупреждает
 * МЯГКО, а кнопка подтверждения остаётся активной.
 */
test('реальный контур: непокрытый пункт чек-листа предупреждает, но сдачу не блокирует (ADR-164)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-progress-1/stages/ms-3');

  const checklist = page.getByTestId('acceptance-checklist');
  await expect(checklist.getByTestId('checklist-item-no-evidence')).toBeVisible();

  await page.getByTestId('submit-stage-cta').click();
  const warning = page.getByTestId('submit-stage-warning');
  await expect(warning).toContainText('Сдать этап всё равно можно');
  await expect(warning).toContainText('Швы затёрты ровно');

  const confirm = page.getByTestId('confirm-submit-stage');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText('На приёмке')).toBeVisible();
});

test('загрузка файла → hash+метка → привязка к пункту → «приложено» на чек-листе (сценарий 2)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9101/stages/st-9101');

  const checklist = page.getByTestId('acceptance-checklist');
  const firstItem = checklist.getByTestId('checklist-item').first();
  await firstItem.getByLabel(/\+ Приложить/).setInputFiles({
    name: 'фото-плитка.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('fake-image'),
  });

  await expect(firstItem.getByText('приложено · 1')).toBeVisible();
});

test('поздняя загрузка помечена «с задержкой N дней» отдельной нейтральной плашкой (сценарий 3)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9102/stages/st-9102');

  await expect(page.getByText('загружено с задержкой 2 дней')).toBeVisible();
});

test('первая сдача + Drive off → DriveBackupPrompt, «Позже» не блокирует сдачу (сценарий 4)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9101/stages/st-9101');

  await page.getByTestId('submit-stage-cta').click();
  await page.getByTestId('confirm-submit-stage').click();

  await expect(page.getByText('Сохраните оригиналы у себя')).toBeVisible();
  await page.getByTestId('drive-prompt-later').click();
  await expect(page.getByText('Сохраните оригиналы у себя')).not.toBeVisible();
  // Сдача не откатилась — этап остаётся на приёмке.
  await expect(page.getByText(/до автоприёмки/)).toBeVisible();
});

test('удаление доказательства доступно до сдачи; после сдачи кнопки нет (сценарий 5)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9102/stages/st-9102');

  const list = page.getByTestId('evidence-list');
  // Сид st-9102 — РОВНО три доказательства. Ждём их появления ожиданием, а не
  // мгновенным count(): список рисуется после ответа мока, и голый count()
  // успевал прочитать ноль — тогда ожидание ниже превращалось в «-1 строк».
  const items = list.getByTestId('evidence-item');
  await expect(items).toHaveCount(3);
  await items.first().getByRole('button', { name: /Удалить/ }).click();
  await expect(items).toHaveCount(2);

  // После сдачи (under_acceptance) — кнопки удаления нет ни у одного доказательства.
  await openAsPerformer(page, '/contracts/c-9103/stages/st-9103');
  await expect(page.getByTestId('evidence-item').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Удалить/ })).toHaveCount(0);
});

test('suspended → CTA неактивна, срок сдвинут (сценарий 6)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9104/stages/st-9104');

  await expect(page.getByTestId('suspended-banner')).toBeVisible();
  await expect(page.getByTestId('submit-stage-cta')).toBeDisabled();
  await expect(page.getByTestId('suspended-banner').getByText('Срок сдвинут')).toBeVisible();
});

test('старт-условие ведёт в договор (сценарий 7)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9101/stages/st-9101');

  await page.getByRole('button', { name: /Договор подписан/ }).click();
  await expect(page).toHaveURL(/\/contracts\/c-9101\/overview$/);
});

test('камера — заглушка, веб-загрузка работает (сценарий 8)', async ({ page }) => {
  await login(page);
  await openAsPerformer(page, '/contracts/c-9101/stages/st-9101');

  await expect(page.getByTestId('camera-stub')).toContainText('в приложении (скоро)');
  await expect(page.getByLabel('Выбрать файлы')).toBeEnabled();
});

/**
 * Реальный контур этапа — гейт старта и передача материалов (ADR-155,
 * решения владельца 03.09). Сид `rc-prepay-1` — договор с ПРЕДОПЛАТОЙ
 * (`payment_order=before_start`), Годвин в нём ЗАКАЗЧИК, у листа есть
 * материал заказчика. `rc-review-1` — тот же экран до подписания.
 */
test('гейт до подписания: все три условия «Ждём» (ADR-155 §5)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-review-1/stages/ms-1');

  const states = page.getByTestId('start-conditions').getByTestId('start-condition-state');
  await expect(states).toHaveText(['Ждём', 'Ждём', 'Ждём']);
});

test('предоплата: финансовое условие названо оплатой этапа, заказчик отмечает передачу материалов', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-prepay-1/stages/ms-prepay-1');

  const gate = page.getByTestId('start-conditions');
  await expect(gate.getByText('Оплата этапа заказчиком')).toBeVisible();
  await expect(gate.getByTestId('start-condition-state')).toHaveText(['Готово', 'Ждём', 'Ждём']);

  const row = page.getByTestId('stage-material-row').first();
  await expect(row.getByTestId('material-state')).toHaveText('Ожидается');
  await row.getByTestId('material-handed-over').click();
  await expect(row.getByTestId('material-state')).toContainText('Передано');
  // «Получено» — шаг ДРУГОЙ стороны: у заказчика этой кнопки нет вовсе.
  await expect(row.getByTestId('material-received')).toHaveCount(0);
});

/**
 * Черновик доказательств на устройстве (ADR-160, жалоба владельца 05.09:
 * «прикладываешь фотографию, но не можешь её удалить»). Сид `rc-progress-1` —
 * подписанный договор, лист `ms-3` в работе, Годвин в нём ИСПОЛНИТЕЛЬ.
 * Здесь черновик живёт в НАСТОЯЩЕЙ IndexedDB браузера, а не в in-memory
 * подмене, как в vitest.
 */
test('черновик: 2 фото → удалил одно → сдал → на сервере ровно одно (ADR-160)', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-progress-1/stages/ms-3');

  await page.getByLabel('Выбрать файлы').setInputFiles([
    { name: 'смазанное.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('blurry') },
    { name: 'хорошее.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('sharp') },
  ]);

  const list = page.getByTestId('evidence-list');
  await expect(list.getByTestId('evidence-item')).toHaveCount(2);
  // Обе строки — черновые: на сервер ничего не ушло, хеша нет.
  await expect(list.getByTestId('evidence-draft-label')).toHaveCount(2);
  await expect(page.getByText('🔒 хеш зафиксирован')).toHaveCount(0);

  await list.getByRole('button', { name: 'Удалить · смазанное.jpg' }).click();
  await expect(list.getByTestId('evidence-item')).toHaveCount(1);
  await expect(page.getByText('смазанное.jpg')).toHaveCount(0);

  await page.getByTestId('submit-stage-cta').click();
  await expect(page.getByText('Будет отправлен 1 файл')).toBeVisible();
  await page.getByTestId('confirm-submit-stage').click();

  await expect(page.getByText('На приёмке')).toBeVisible();
  const stored = page.getByTestId('evidence-list').getByTestId('evidence-item');
  await expect(stored).toHaveCount(1);
  await expect(stored.first()).toContainText('хорошее.jpg');
  // Ушедшее стало настоящим доказательством, черновиков не осталось.
  await expect(page.getByTestId('evidence-draft-label')).toHaveCount(0);
  await expect(page.getByText('🔒 хеш зафиксирован')).toBeVisible();
});

/**
 * Черновик заказчика (расширение ADR-160, решение владельца 05.09: «дать
 * заказчику такой же черновик и кнопку „Отправить приложенное“. вдруг он
 * случайно личное фото приложит. + он даст описание и потом одним рейсом все
 * отправит»). Сид `rc-signed-review-1` — лист `ms-review-1` на приёмке, Годвин
 * в нём ЗАКАЗЧИК. Здесь черновик живёт в настоящей IndexedDB браузера.
 */
test('заказчик: 2 файла → удалил личное → описание → «Отправить приложенное» одним рейсом', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/rc-signed-review-1/stages/ms-review-1');

  await expect(page.getByTestId('acceptance-review-list')).toBeVisible();
  // До первого файла отправлять нечего.
  await expect(page.getByTestId('send-attached-cta')).toBeDisabled();

  await page.getByLabel('Выбрать файлы').setInputFiles([
    { name: 'личное.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('private') },
    { name: 'скол.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('defect') },
  ]);

  const list = page.getByTestId('evidence-list');
  // Оба — черновые: на сервере по-прежнему только доказательство исполнителя.
  await expect(list.getByTestId('evidence-draft-label')).toHaveCount(2);
  await expect(list.getByText('стена-1.jpg')).toBeVisible();

  await list.getByRole('button', { name: 'Удалить · личное.jpg' }).click();
  await expect(list.getByTestId('evidence-draft-label')).toHaveCount(1);
  await expect(page.getByText('личное.jpg')).toHaveCount(0);

  await page.getByLabel('Описание').fill('Скол на левом углу подоконника');
  await page.getByTestId('send-attached-cta').click();

  // Файл стал настоящим доказательством: черновиков не осталось, описание
  // приехало вместе с ним, поле очищено под следующую партию.
  await expect(page.getByTestId('evidence-draft-label')).toHaveCount(0);
  await expect(page.getByText('Скол на левом углу подоконника')).toBeVisible();
  await expect(page.getByLabel('Описание')).toHaveValue('');
  await expect(page.getByTestId('send-attached-cta')).toBeDisabled();
});
