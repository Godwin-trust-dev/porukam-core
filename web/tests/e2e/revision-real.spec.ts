import { test, expect, type Page } from '@playwright/test';

/**
 * «Предложить правку» на РЕАЛЬНОМ контуре (ADR-123 / ADR-157) — окно
 * `RealProposeRevisionModal` на карточке `realContractsDb`.
 *
 * Зачем отдельная спека: в e2e протокол разногласий был только мок-путём Ф1
 * (`contract-flow.spec.ts` — три свободных текстовых поля старого экрана
 * `c-3001`). Реальное окно устроено иначе: «Что меняем» — комбобокс по пунктам
 * договора, «Было» читается из договора, «Стало» — виджет по типу поля с
 * предзаполнением, а 422 бэка показывается У ПОЛЯ, а не тостом. Ни один из
 * этих узлов в браузере не проверялся.
 *
 * `rc-review-1` — «Сборка мебели — гостиная» на согласовании (`under_review`),
 * Годвин в нём заказчик; два листа-этапа с суммами (`ms-1` 18 000 ₽,
 * `ms-2` 7 000 ₽).
 */

async function login(page: Page): Promise<void> {
  // Прямая навигация на /login (как в smoke/dashboard): `RequireAuth` уводит
  // с '/' на /welcome.
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

/** Переход внутри SPA: полный `goto` сбросил бы токены в памяти (§13.2). */
async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * «Переговоры и подписи». С 07.09 (замечание владельца — сперва про десктоп,
 * затем про телефон) воронки и шита у карточки сделки нет ни на одной
 * раскладке: все вкладки стоят в полосе (на узком экране — в несколько рядов),
 * вкладка открывается прямым кликом.
 */
async function openProposeRevision(page: Page): Promise<void> {
  await openPath(page, '/contracts/rc-review-1');
  await expect(page.getByText('Сборка мебели — гостиная').first()).toBeVisible();
  await page.getByTestId('tab-negoSign').click();
  await page.getByTestId('real-propose-revision').click();
}

/** «Что меняем» — `SearchSelect`: пункты живут в DOM, только пока список открыт. */
async function pickRevisionItem(page: Page, name: RegExp): Promise<void> {
  await page.getByTestId('real-revision-item').click();
  await page.getByRole('listbox').waitFor();
  await page.getByRole('option', { name }).click();
}

test('правка суммы этапа: «Было» из договора, предзаполненное «Стало» → правка в блоке согласования', async ({
  page,
}) => {
  await login(page);
  await openProposeRevision(page);

  await pickRevisionItem(page, /Шкаф-купе · Сумма/);

  // «Было» — деньги с валютой, только для чтения: бэк подставляет его сам.
  const before = page.getByTestId('real-revision-before');
  await expect(before).toHaveAttribute('readonly', '');
  await expect(before).toHaveValue(/18\s?000/);

  // «Стало» стартует от текущей суммы (пара {amount, currency} — в поле только
  // число), и пока значение не изменилось, отправлять нечего.
  const after = page.getByTestId('real-revision-after');
  await expect(after).toHaveValue('18000.00');
  await expect(page.getByTestId('real-submit-revision')).toBeDisabled();

  await after.fill('20000');
  await page.getByTestId('real-submit-revision').click();

  const revision = page.getByTestId('real-revision');
  await expect(revision).toBeVisible();
  await expect(revision.getByTestId('real-revision-item-label')).toHaveText(/Шкаф-купе · Сумма/);
  await expect(revision).toContainText('открыта');
  // Обе стороны пары показаны деньгами, а не JSON-ом.
  await expect(revision).toContainText(/18\s?000/);
  await expect(revision).toContainText(/20\s?000/);
  // Своё предложение решать нельзя.
  await expect(revision.getByRole('button', { name: 'Принять' })).toHaveCount(0);
});

test('правка условия оплаты: способ расчёта выбирается списком, а не текстом', async ({ page }) => {
  await login(page);
  await openProposeRevision(page);

  await pickRevisionItem(page, /Способ расчёта/);

  // Предзаполнено текущим способом (`cash` у rc-review-1) — подписью, не кодом.
  await expect(page.getByTestId('real-revision-before')).toHaveValue(/[Нн]аличн/);
  await expect(page.getByTestId('real-revision-after')).toHaveValue('cash');

  await page.getByTestId('real-revision-after').selectOption('direct_platform');
  await page.getByTestId('real-submit-revision').click();

  const revision = page.getByTestId('real-revision');
  await expect(revision.getByTestId('real-revision-item-label')).toHaveText('Способ расчёта');
  await expect(revision).toContainText('открыта');
});

test('422 по коду поля показывается у «Стало», окно остаётся открытым, правка не создана', async ({
  page,
}) => {
  await login(page);
  await openProposeRevision(page);

  await pickRevisionItem(page, /Шкаф-купе · Сумма/);
  await page.getByTestId('real-revision-after').fill('-500');
  await page.getByTestId('real-submit-revision').click();

  // `negative` бэка → своя фраза на языке интерфейса, у поля, а не тостом.
  await expect(page.getByText('Значение не может быть отрицательным.')).toBeVisible();
  await expect(page.getByTestId('real-revision-after')).toBeVisible();
  await expect(page.getByTestId('real-revision')).toHaveCount(0);
});
