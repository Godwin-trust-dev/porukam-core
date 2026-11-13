import { test, expect, type Page } from '@playwright/test';

/** ADR-088 Фаза 2 — мастер создания на РЕАЛЬНОМ контракте API (мок зеркалит
 * `apps.contracts`/`apps.milestones`/ADR-094): черновик создаётся на шаге
 * «Стороны» (POST /contracts требует контрагента), существо — по серверной
 * схеме услуги, этапы — плоскими POST /contracts/{id}/milestones. */

async function loginAndOpenWizard(page: Page): Promise<void> {
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
  // Клиентская навигация (не page.goto) — authStore живёт в памяти SPA, полная
  // перезагрузка сбросила бы вход (§ дневник отладки: authStore без persist).
  await page.getByTestId('create-contract').click();
  await page.waitForURL(/\/contracts\/new\/type/);
}

async function pickCounterparty(page: Page): Promise<void> {
  await page.getByTestId('counterparty-search').fill('Мастер');
  await page.getByTestId('handle-@masterremont').click();
}

test.describe('ADR-088 Фаза 2 · мастер создания на реальном API', () => {
  test('услуга: тип → сфера → стороны (создание) → суть (схема сервера) → этапы → условия → превью → отправка', async ({ page }) => {
    await loginAndOpenWizard(page);

    // Тип — черновик НЕ создаётся, только выбор.
    await page.getByTestId('type-service').click();
    await page.getByTestId('wizard-next').click();

    // Сфера — локальный выбор (sphere_code уйдёт в form_data на «Сути»).
    await page.waitForURL(/\/sphere/);
    await page.getByTestId('sphere-repair').click();
    await expect(page.getByTestId('sphere-chosen')).toHaveText('Ремонт и строительство');
    await page.getByTestId('wizard-next').click();

    // Стороны — здесь происходит POST /contracts (контрагент обязателен).
    await page.waitForURL(/\/parties/);
    await expect(page.getByTestId('identity-card')).toBeVisible();
    await expect(page.getByTestId('wizard-next')).toBeDisabled();
    await pickCounterparty(page);
    await page.getByTestId('wizard-next').click();

    // Суть — обязательные поля серверной схемы услуги; «Далее» заблокировано, пока не заполнены.
    await page.waitForURL(/\/details/);
    await page.getByTestId('contract-title').fill('Ремонт кухни «под ключ»');
    await expect(page.getByTestId('wizard-next')).toBeDisabled();
    await page.getByTestId('work-description').fill('Демонтаж, стяжка, укладка плитки');
    await page.getByTestId('location-address').fill('Москва, ул. Строителей, 5');
    await page.getByTestId('start-date').fill('2026-09-01');
    await page.getByTestId('end-date').fill('2026-09-30');
    await page.getByTestId('wizard-next').click();

    // Этапы — «стоимость работ» разносится поровну; правка одного не ломает итог.
    await page.waitForURL(/\/stages/);
    await page.getByTestId('add-stage').click();
    await page.getByTestId('add-stage').click();
    await page.getByTestId('add-stage').click();
    await page.getByTestId('total-cost').fill('120000');
    await expect(page.getByTestId('stages-sum')).toHaveText('120000.00 RUB');
    await expect(page.getByTestId('sum-match-badge')).toContainText('Сходится');

    await page.getByTestId('stage-open').first().click();
    await page.getByTestId('stage-amount').fill('50000');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('stages-sum')).toHaveText('120000.00 RUB');
    await expect(page.getByTestId('sum-match-badge')).toContainText('Сходится');
    // Реальный Milestone: длительности/аванса/разделов нет — элементы скрыты;
    // материалы вернулись на шаг (решение владельца 03.09) — кнопка есть.
    await expect(page.getByTestId('add-section')).toHaveCount(0);
    await page.getByTestId('stage-open').first().click();
    await expect(page.getByTestId('open-materials')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('wizard-next').click();

    // Условия — дефолты серверной схемы (дни/часы, не месяцы) + способ оплаты
    // (без него превью блокирует отправку: гейт этапа payment_method_not_set,
    // а после /send поле уже не патчится — §E-смоук).
    await page.waitForURL(/\/terms/);
    await expect(page.getByLabel('Гарантия, дней')).toHaveValue('14');
    await expect(page.getByLabel('Окно приёмки, часов')).toHaveValue('72');
    await page.getByTestId('payment-method-select').selectOption('cash');
    // Порядок оплаты — обязательное поле шага (ADR-151), без него «Далее» закрыта.
    await page.getByTestId('payment-order-select').selectOption('after_acceptance');
    // ADR-167: свободное условие — единственное место в мастере, где стороны
    // пишут своими словами; уходит тем же PATCH, что form_data шага.
    await page.getByTestId('additional-term-add').click();
    await page.getByTestId('additional-term-0').fill('Ключи передаются под расписку');
    await page.getByTestId('wizard-next').click();

    // Превью → отправка → деталь договора (слой чтения Фазы 1, реальный id rc-*).
    await page.waitForURL(/\/preview/);
    await expect(page.getByTestId('preview-step')).toBeVisible();
    await expect(page.getByText('Наличные при встрече')).toBeVisible();
    await page.getByTestId('send-for-review').click();
    await page.waitForURL(/\/contracts\/rc-/);

    // ADR-167: условие видно в тексте договора. Вкладка «Условия» карточки и
    // экран подписания рисуют ОДИН список (`contract.termsAdditionalTitle`,
    // нумерованный) — карточка достижима сразу после отправки, экран
    // подписания требует заморозки обеими сторонами (не сценарий мастера).
    await page.getByRole('tab', { name: 'Условия' }).click();
    await page.getByTestId('see-all-terms').click();
    await expect(page.getByTestId('real-terms-additional')).toContainText(
      'Ключи передаются под расписку',
    );
  });

  test('без способа оплаты шаг «Условия» не пускает дальше (гейт переехал из превью)', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-service').click();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('sphere-repair').click();
    await page.getByTestId('wizard-next').click();
    await pickCounterparty(page);
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/details/);
    await page.getByTestId('work-description').fill('Работы');
    await page.getByTestId('location-address').fill('Адрес');
    await page.getByTestId('start-date').fill('2026-09-01');
    await page.getByTestId('end-date').fill('2026-09-10');
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/stages/);
    await page.getByTestId('add-stage').click();
    await page.getByTestId('total-cost').fill('10000');
    await page.getByTestId('wizard-next').click();
    // Раньше без способа оплаты можно было дойти до превью и там упереться в
    // заблокированную отправку. Теперь гейт стоит на самом шаге «Условия»
    // (TermsStepPage: `nextDisabled={!paymentMethod || !paymentOrder}`) — до превью
    // с пустым способом оплаты из мастера уже не дойти, и проверять надо это.
    await page.waitForURL(/\/terms/);
    await expect(page.getByTestId('wizard-next')).toBeDisabled();

    // Способа оплаты мало: с ADR-151 обязателен и порядок оплаты — блокировка держится.
    await page.getByTestId('payment-method-select').selectOption('cash');
    await expect(page.getByTestId('wizard-next')).toBeDisabled();

    // Заполнены оба обязательных поля — блокировка снята.
    await page.getByTestId('payment-order-select').selectOption('after_acceptance');
    await expect(page.getByTestId('wizard-next')).toBeEnabled();
  });

  test('созданный этап можно удалить (ADR-101) и скопировать; «Сохранить» закрывает окно этапа', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-service').click();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('sphere-repair').click();
    await page.getByTestId('wizard-next').click();
    await pickCounterparty(page);
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/details/);
    await page.getByTestId('work-description').fill('Работы');
    await page.getByTestId('location-address').fill('Адрес');
    await page.getByTestId('start-date').fill('2026-09-01');
    await page.getByTestId('end-date').fill('2026-09-10');
    await page.getByTestId('wizard-next').click();

    await page.waitForURL(/\/stages/);
    await page.getByTestId('add-stage').click();
    await page.getByTestId('total-cost').fill('10000');
    // Окно этапа: явная кнопка «Сохранить» закрывает его (отсмотр 2026-08-20).
    await page.getByTestId('stage-open').click();
    await expect(page.getByTestId('stage-editor')).toBeVisible();
    await page.getByTestId('stage-save').click();
    await expect(page.getByTestId('stage-editor')).toHaveCount(0);
    // Копия — вторая строка, сумма разнеслась поровну.
    await page.getByTestId('stage-copy').first().click();
    await expect(page.getByTestId('stage-row')).toHaveCount(2);
    // Сохранили (создались на сервере) → вернулись: удаление по-прежнему доступно.
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/terms/);
    await page.getByTestId('wizard-back').click();
    await page.waitForURL(/\/stages/);
    await expect(page.getByTestId('stage-row')).toHaveCount(2);
    await expect(page.getByTestId('stage-remove')).toHaveCount(2);
    await page.getByTestId('stage-remove').first().click();
    await expect(page.getByTestId('stage-row')).toHaveCount(1);
    // «Далее» шлёт DELETE созданному этапу — после возврата его нет.
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/terms/);
    await page.getByTestId('wizard-back').click();
    await page.waitForURL(/\/stages/);
    await expect(page.getByTestId('stage-row')).toHaveCount(1);
  });

  test('продажа: уточнение кода из каталога, форма существа → единственный этап → превью с отправкой', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-sale').click();
    // Пока код не уточнён — «Далее» закрыта и видна подсказка (отсмотр 2026-08-18 №5).
    await expect(page.getByTestId('wizard-next')).toBeDisabled();
    await expect(page.getByTestId('subtype-hint')).toBeVisible();
    // ADR-094 — подвыбор конкретного кода (личное имущество / бизнес).
    await page.getByTestId('subtype-sale_personal').click();
    await expect(page.getByTestId('subtype-hint')).toHaveCount(0);
    await page.getByTestId('wizard-next').click();

    // Продажа не проходит через «Сферу» — сразу «Стороны».
    await page.waitForURL(/\/parties/);
    await pickCounterparty(page);
    await page.getByTestId('wizard-next').click();

    // Суть — форма продажи (SALE_PERSONAL_SCHEMA), «Далее» закрыта до обязательных полей.
    await page.waitForURL(/\/details/);
    await expect(page.getByTestId('form-not-connected')).toHaveCount(0);
    await expect(page.getByTestId('wizard-next')).toBeDisabled();
    await page.getByTestId('sale-item-name').fill('Диван угловой');
    await page.getByTestId('sale-item-description').fill('Серый, 2 года');
    await page.getByTestId('sale-price').fill('45000');
    await page.getByTestId('sale-delivery-date').fill('2026-09-01');
    await page.getByTestId('payment-method-select').selectOption('cash');
    // Порядок оплаты — обязательное поле формы продажи (ADR-151).
    await page.getByTestId('payment-order-select').selectOption('after_acceptance');
    await expect(page.getByTestId('wizard-next')).toBeEnabled();
    await page.getByTestId('wizard-next').click();

    // Этапы/Условия свёрнуты — сразу превью; этап «передача товара» создан шагом «Суть», отправка доступна.
    await page.waitForURL(/\/preview/);
    await expect(page.getByText('Диван угловой').first()).toBeVisible();
    await expect(page.getByTestId('send-for-review')).toBeEnabled();
  });

  test('услуга: «Все сферы» показывает полный список, переключатель не исчезает (отсмотр 2026-08-18 №4)', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-service').click();
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/sphere/);

    await page.getByTestId('sphere-browse-all').click();
    // Полный список — включая НЕпопулярные сферы; переключатель остался на экране.
    await expect(page.getByTestId('sphere-cleaning')).toBeVisible();
    await expect(page.getByTestId('sphere-browse-all')).toBeVisible();
    await page.getByTestId('sphere-cleaning').click();
    await expect(page.getByTestId('sphere-chosen')).toHaveText('Уборка');
  });

  test('услуга: нечёткий поиск сфер — опечатка находит, повторный поиск заменяет выбор (отсмотр 2026-08-19, ADR-097)', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-service').click();
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/sphere/);

    // Опечатка «римонт» → сфера «Ремонт и строительство» всё равно находится (нечёткий матч).
    await page.getByTestId('sphere-search').fill('римонт');
    await page.getByTestId('sphere-repair').click();
    await expect(page.getByTestId('sphere-chosen')).toHaveText('Ремонт и строительство');
    // Выбор очистил строку поиска и закрыл выдачу.
    await expect(page.getByTestId('sphere-search')).toHaveValue('');

    // Сфера уже выбрана — новый поиск и клик по другой сфере ЗАМЕНЯЮТ выбор.
    await page.getByTestId('sphere-search').fill('уборка');
    await page.getByTestId('sphere-cleaning').click();
    await expect(page.getByTestId('sphere-chosen')).toHaveText('Уборка');
  });

  test('стороны: контрагент выбирается из книги контактов, поиск внутри шита фильтрует справочник', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-service').click();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('sphere-repair').click();
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/parties/);

    // Решение владельца 05.09: книга контактов открывается прямо от поля
    // «Вторая сторона», хендл вставлять необязательно.
    await page.getByTestId('open-contacts').click();
    await expect(page.getByTestId('contacts-picker-list')).toBeVisible();
    await expect(page.getByTestId('contacts-picker-@irina_s')).toBeVisible();

    // Поиск фильтрует с первого символа — «Ирина» из выдачи уходит.
    await page.getByTestId('contacts-picker-search').fill('мастер');
    await expect(page.getByTestId('contacts-picker-@irina_s')).toHaveCount(0);
    await page.getByTestId('contacts-picker-@masterremont').click();

    // Шит закрылся, поле заполнено, «Далее» открылась.
    await expect(page.getByTestId('contacts-picker-search')).toHaveCount(0);
    await expect(page.getByTestId('counterparty-search')).toHaveValue('Мастер Ремонт');
    await expect(page.getByTestId('wizard-next')).toBeEnabled();
  });

  test('стороны: контакта нет — из шита уходим в поиск по платформе и сохраняем контакт', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-service').click();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('sphere-repair').click();
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/parties/);

    await page.getByTestId('open-contacts').click();
    await page.getByTestId('contacts-picker-search').fill('svetdom');
    const searchPlatform = page.getByTestId('contacts-picker-search-platform');
    await expect(searchPlatform).toContainText('svetdom');
    await searchPlatform.click();
    await page.getByTestId('contacts-picker-handle-@svetdom').click();

    await expect(page.getByTestId('counterparty-search')).toHaveValue('ООО «СветДом»');
    // Выбрали не из справочника — предлагается положить туда (необязательно).
    await page.getByTestId('save-counterparty-contact').click();
    await expect(page.getByTestId('counterparty-saved')).toBeVisible();
  });

  test('займ: единственный код выбирается автоматически', async ({ page }) => {
    await loginAndOpenWizard(page);
    await page.getByTestId('type-loan').click();
    // Подвыбора нет (один код loan_individuals) — «Далее» активна сразу.
    await expect(page.getByTestId('wizard-next')).toBeEnabled();
    await page.getByTestId('wizard-next').click();
    await page.waitForURL(/\/parties/);
  });
});
