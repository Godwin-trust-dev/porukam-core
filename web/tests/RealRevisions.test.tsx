import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { createMaterial, createRevision, listMaterials, listRevisions } from '../src/mocks/realContractsDb';

/**
 * Протокол разногласий на РЕАЛЬНОМ контуре (fix/web-revisions-real-api):
 * раньше панель была read-only, интерактив жил только на мок-путях Ф1.
 * rc-review-1 — under_review, pf-person-1 — заказчик.
 */

/**
 * «Что меняем» — комбобокс с поиском (`SearchSelect`), а не нативный `select`:
 * пункты существуют в DOM только пока список открыт, а доступное имя пункта
 * несёт ещё и текущее значение серой строкой — поэтому имена ищем регуляркой.
 */
async function openRevisionItems(): Promise<void> {
  await userEvent.click(await screen.findByTestId('real-revision-item'));
  await screen.findByRole('listbox');
}

async function pickRevisionItem(name: RegExp): Promise<void> {
  await openRevisionItems();
  await userEvent.click(screen.getByRole('option', { name }));
}

/** «Стало» тоже бывает комбобоксом с поиском — тип материала выбирается из
 * каталога тем же `SearchSelect`, что и в окне «Материалы» (ADR-157). */
async function pickAfterOption(name: RegExp): Promise<void> {
  await userEvent.click(await screen.findByTestId('real-revision-after'));
  await screen.findByRole('listbox');
  await userEvent.click(screen.getByRole('option', { name }));
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

async function openNegoTab(): Promise<void> {
  await screen.findByText('Сборка мебели — гостиная');
  await openCardTab('negoSign');
}

/**
 * Вкладки карточки сделки (замечание владельца 07.09): воронки и шита у
 * карточки больше нет — ВСЕ вкладки стоят в полосе (на телефоне в несколько
 * рядов), поэтому путь человека — прямой клик по вкладке.
 */
async function openCardTab(value: string): Promise<void> {
  await userEvent.click(await screen.findByTestId(`tab-${value}`));
}

describe('Протокол разногласий — реальный контур', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('предложить правку: выбор поля → «Было» из договора → POST → статус «открыта»', async () => {
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));

    // ADR-123: «Что меняем» — список полей договора, а не свободная строка;
    // список приходит из схемы формы типа, поэтому ждём опцию.
    await pickRevisionItem(/Окончание/);

    // «Было» подставилось из form_data договора и только читается.
    const before = screen.getByTestId('real-revision-before') as HTMLInputElement;
    expect(before).toHaveAttribute('readonly');
    expect(before.value).not.toBe('');

    // «Стало» — виджет по типу поля: date → input[type=date].
    const after = screen.getByTestId('real-revision-after') as HTMLInputElement;
    expect(after.type).toBe('date');
    fireEvent.change(after, { target: { value: '2026-09-12' } });
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    const revision = await screen.findByTestId('real-revision');
    // Адрес правки показывается подписью поля, а не ключом `form.end_date`.
    expect(within(revision).getByTestId('real-revision-item-label')).toHaveTextContent('Окончание');
    expect(within(revision).getByText('открыта')).toBeInTheDocument();
    // Своё предложение решать нельзя — кнопок «Принять/Отклонить» нет.
    expect(within(revision).queryByText('Принять')).not.toBeInTheDocument();
  });

  it('«Что меняем» несёт секции оплаты, этапов и материалов (владелец 03.09: «надо чтобы были все пункты»)', async () => {
    createMaterial('ms-1', {
      catalog_item_code: 'cat-tile',
      description: 'Плитка керамическая',
      source: 'customer',
      unit_price: '1200.00',
      unit_price_currency: 'RUB',
      quantity: '12',
      unit: 'm2',
      delivery_days: 3,
    });
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));
    await openRevisionItems();

    const list = screen.getByRole('listbox');
    for (const section of ['Оплаты', 'Этапы', 'Материалы', 'Условия']) {
      expect(within(list).getByText(section)).toBeInTheDocument();
    }
    // Способ расчёта и порядок оплаты (ADR-151/155) — их в списке не было вовсе.
    expect(screen.getByRole('option', { name: /Способ расчёта/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Порядок оплаты/ })).toBeInTheDocument();
    // Лист дерева этапов: сумма и срок.
    expect(screen.getAllByRole('option', { name: /Сумма/ }).length).toBeGreaterThan(0);
    // Позиция материалов: срок поставки.
    expect(screen.getByRole('option', { name: /Плитка керамическая · Срок поставки/ })).toBeInTheDocument();

    // ADR-157: бэк применяет такую правку сам — предупреждения «в текст
    // договора её вносят стороны» в окне больше нет (оно было честным, пока
    // адрес не применялся, и стало бы неправдой сейчас).
    await userEvent.click(screen.getByRole('option', { name: /Способ расчёта/ }));
    expect(screen.queryByText(/вносят стороны|фиксируется в протоколе согласования/)).not.toBeInTheDocument();

    // «Стало» предзаполнено ТЕКУЩИМ способом расчёта (у rc-review-1 — наличные),
    // и пока значение не изменилось, отправить нечего: правка «было X → стало X»
    // ничего не согласовывает.
    const after = screen.getByTestId('real-revision-after') as HTMLSelectElement;
    expect(after.value).toBe('cash');
    expect(screen.getByTestId('real-submit-revision')).toBeDisabled();

    fireEvent.change(after, { target: { value: 'direct_platform' } });
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    const revision = await screen.findByTestId('real-revision');
    expect(within(revision).getByTestId('real-revision-item-label')).toHaveTextContent('Способ расчёта');
    expect(within(revision).getByText('открыта')).toBeInTheDocument();
  }, 30_000);

  /**
   * ADR-157: бэк применяет правки этапов и материалов сам, поэтому значение
   * должно уходить в том виде, который он принимает. До этой ветки фронт слал
   * тип материала свободным текстом, условие старта — сырым идентификатором в
   * текстовом поле, сумму — строкой без валюты: такие правки бэк теперь
   * отвергает 422 с кодом поля.
   */
  it('тип материала уходит КОДОМ позиции каталога, а «Было» — названием', async () => {
    createMaterial('ms-1', {
      catalog_item_code: 'cat-tile',
      description: 'Плитка на пол',
      source: 'customer',
      unit_price: '1200.00',
      unit_price_currency: 'RUB',
      quantity: '12',
      unit: 'm2',
      delivery_days: 3,
    });
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));
    await pickRevisionItem(/Плитка на пол · Тип материала/);

    // «Было» — человеческое название позиции каталога (`cat-tile`), не код.
    expect((screen.getByTestId('real-revision-before') as HTMLInputElement).value).toBe('Плитка керамическая');

    // «Стало» — тот же комбобокс с поиском, что выбирает тип в «Материалах».
    await pickAfterOption(/Ламинат/);
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    await screen.findByTestId('real-revision');
    expect(listRevisions('rc-review-1')[0]).toMatchObject({
      item_ref: `material.${listMaterials('ms-1')[0]!.id}.type`,
      new_value: 'cat-laminate',
      old_value: 'cat-tile',
    });
  }, 30_000);

  it('условие старта — выбор этапа-предшественника (не свободный текст), сам на себя не предлагается', async () => {
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));
    await pickRevisionItem(/Стеллаж · Условие старта/);

    const after = screen.getByTestId('real-revision-after');
    expect(after.tagName).toBe('SELECT');
    // Пусто — законное значение («предшественника нет»), поэтому у него свой
    // пункт, а не плейсхолдер «выберите значение».
    expect(within(after).getByRole('option', { name: 'Без этапа-предшественника' })).toBeInTheDocument();
    expect(within(after).getByRole('option', { name: 'Шкаф-купе' })).toBeInTheDocument();
    expect(within(after).queryByRole('option', { name: 'Стеллаж' })).not.toBeInTheDocument();

    await userEvent.selectOptions(after, 'ms-1');
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    await screen.findByTestId('real-revision');
    expect(listRevisions('rc-review-1')[0]).toMatchObject({
      item_ref: 'milestone.ms-2.start_gate',
      new_value: 'ms-1',
    });
  }, 30_000);

  it('сумма этапа: «Было» — деньги с валютой, «Стало» уходит парой {amount, currency}', async () => {
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));
    await pickRevisionItem(/Шкаф-купе · Сумма/);

    // Валюты по умолчанию нет нигде (CLAUDE.md): «Было» показывает пару.
    expect((screen.getByTestId('real-revision-before') as HTMLInputElement).value).toMatch(/18\s?000/);

    fireEvent.change(screen.getByTestId('real-revision-after'), { target: { value: '20000' } });
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    await screen.findByTestId('real-revision');
    expect(listRevisions('rc-review-1')[0]).toMatchObject({
      item_ref: 'milestone.ms-1.amount',
      new_value: { amount: '20000', currency: 'RUB' },
      old_value: { amount: '18000.00', currency: 'RUB' },
    });
  }, 30_000);

  /**
   * Находка 04.09: `revisionValueToInput` была написана, но «Стало» оставалось
   * пустым — человек перебивал значение руками, глядя в соседнее «Было».
   * Теперь виджет стартует от текущего значения, а неизменённое значение
   * отправить нельзя.
   */
  it('«Стало» предзаполнено текущим значением, неизменённое отправить нельзя', async () => {
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));
    await pickRevisionItem(/Шкаф-купе · Сумма/);

    // Сумма лежит парой {amount, currency} — в поле уходит только число.
    const after = screen.getByTestId('real-revision-after') as HTMLInputElement;
    expect(after.value).toBe('18000.00');
    expect(screen.getByTestId('real-submit-revision')).toBeDisabled();

    // Смена пункта переставляет предзаполнение на новый пункт, а не тащит
    // значение прошлого.
    await pickRevisionItem(/Стеллаж · Сумма/);
    expect((screen.getByTestId('real-revision-after') as HTMLInputElement).value).toBe('7000.00');

    fireEvent.change(screen.getByTestId('real-revision-after'), { target: { value: '7500' } });
    expect(screen.getByTestId('real-submit-revision')).toBeEnabled();
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    await screen.findByTestId('real-revision');
    expect(listRevisions('rc-review-1')[0]).toMatchObject({
      item_ref: 'milestone.ms-2.amount',
      new_value: { amount: '7500', currency: 'RUB' },
    });
  }, 30_000);

  it('«Другое» предзаполнять нечем — свободное условие набирается с нуля', async () => {
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));
    await pickRevisionItem(/^Другое/);

    const after = screen.getByTestId('real-revision-after') as HTMLTextAreaElement;
    expect(after.value).toBe('');
    expect(screen.getByTestId('real-submit-revision')).toBeDisabled();
  }, 30_000);

  it('422 по коду поля показывается У ПОЛЯ «Стало», а не общим тостом', async () => {
    createMaterial('ms-1', {
      catalog_item_code: 'cat-tile',
      description: 'Плитка на пол',
      source: 'customer',
      unit_price: '1200.00',
      unit_price_currency: 'RUB',
      quantity: '12',
      unit: 'm2',
      delivery_days: 3,
    });
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-propose-revision'));
    await pickRevisionItem(/Плитка на пол · Количество/);

    fireEvent.change(screen.getByTestId('real-revision-after'), { target: { value: '0' } });
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    // `not_positive` бэка → своя фраза на языке интерфейса, не служебное
    // сообщение сервера; окно остаётся открытым, правка не создана.
    expect(await screen.findByText('Значение должно быть больше нуля.')).toBeInTheDocument();
    expect(listRevisions('rc-review-1')).toHaveLength(0);
  }, 30_000);

  it('«Другое»: произвольное условие — принятое, попадает в «Дополнительные условия»', async () => {
    createRevision(
      'rc-review-1',
      { item_ref: 'other', new_value: 'Упаковку вывозит исполнитель в день сдачи.' },
      'pf-mock-contractor-1',
    );
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    const revision = await screen.findByTestId('real-revision');
    await userEvent.click(within(revision).getByText('Принять'));
    await waitFor(() => expect(screen.getByText('принята')).toBeInTheDocument());

    // После принятия карточка перезапрашивается — условие видно во вкладке «Условия».
    await userEvent.click(screen.getByRole('tab', { name: /Условия/ }));
    // Доска B: полный список условий раскрывается «Смотреть все условия».
    await userEvent.click(await screen.findByTestId('see-all-terms'));
    const block = await screen.findByTestId('real-terms-additional');
    expect(within(block).getByText('Упаковку вывозит исполнитель в день сдачи.')).toBeInTheDocument();
  });

  it('принятая правка по полю формы меняет договор — условия показывают новое значение', async () => {
    createRevision(
      'rc-review-1',
      { item_ref: 'form.warranty_period_days', new_value: 30 },
      'pf-mock-contractor-1',
    );
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    const revision = await screen.findByTestId('real-revision');
    // «Было» бэк подставил сам — 14 из form_data.
    expect(within(revision).getByText('14')).toBeInTheDocument();
    await userEvent.click(within(revision).getByText('Принять'));
    await waitFor(() => expect(screen.getByText('принята')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /Условия/ }));
    await userEvent.click(await screen.findByTestId('see-all-terms'));
    const row = await screen.findByTestId('real-terms-warranty_period_days');
    expect(within(row).getByText('30')).toBeInTheDocument();
  });

  it('чужая правка: принять — статус «принята»', async () => {
    createRevision(
      'rc-review-1',
      { item_ref: 'Цвет фасадов', old_value: 'белый', new_value: 'дуб' },
      'pf-mock-contractor-1',
    );
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    const revision = await screen.findByTestId('real-revision');
    await userEvent.click(within(revision).getByText('Принять'));
    await waitFor(() => expect(screen.getByText('принята')).toBeInTheDocument());
  });

  it('чужая правка: встречная — старая «закрыта встречной», новая открыта', async () => {
    createRevision(
      'rc-review-1',
      { item_ref: 'Цена стеллажа', old_value: '7000', new_value: '9000' },
      'pf-mock-contractor-1',
    );
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    const revision = await screen.findByTestId('real-revision');
    await userEvent.click(within(revision).getByText('Встречная'));
    await userEvent.type(screen.getByTestId('real-counter-value'), '8000');
    // В DOM две кнопки «Встречная» (строка правки + сабмит модалки) — жмём модальную.
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Встречная' }));

    await waitFor(() => expect(screen.getByText('закрыта встречной')).toBeInTheDocument());
    expect(screen.getAllByTestId('real-revision')).toHaveLength(2);
  });

  it('«Принять все» с денежной правкой: сводка → подтверждение → принято', async () => {
    createRevision(
      'rc-review-1',
      { item_ref: 'Цена шкафа', old_value: '18000', new_value: '20000' },
      'pf-mock-contractor-1',
    );
    renderPage('/contracts/rc-review-1');
    await openNegoTab();
    await userEvent.click(await screen.findByTestId('real-accept-all'));
    // Финансово значимая правка — сначала сводка «было -> стало».
    await userEvent.click(await screen.findByTestId('real-confirm-accept-all'));
    await waitFor(() => expect(screen.getByText('принята')).toBeInTheDocument());
  });
});

/**
 * Хвосты 2026-08-25: мок-схема формы была только у `services_*`, поэтому на
 * sale/rent/loan «Что меняем» падало в фолбэк по ключам `form_data`, а сама
 * правка резалась мок-бэком в 422 `revision_item_unknown`. Схемы сняты с
 * `apps.contracts.forms` один в один, сид-договоры этих типов заведены.
 */
describe('Протокол разногласий — типы, кроме услуг (мок-схемы форм)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('аренда жилья: «Что меняем» — поля схемы rent_home, правка по полю проходит', async () => {
    renderPage('/contracts/rc-rent-review-1');
    await screen.findByText('Аренда квартиры на Абая');
    await openCardTab('negoSign');
    await userEvent.click(await screen.findByTestId('real-propose-revision'));

    // Подписи — из схемы (`contractNew.schemaForm.rent_home.field.*`),
    // а не `humanize('rent_amount')` фолбэка.
    await openRevisionItems();
    await screen.findByRole('option', { name: /Плата в месяц/ });
    expect(screen.getByRole('option', { name: /^Адрес/ })).toBeInTheDocument();
    // Условно скрытое поле не предлагаем: term_kind=long_term → срока в днях нет.
    expect(screen.queryByRole('option', { name: /Срок, дней/ })).not.toBeInTheDocument();
    // utilities_mode=by_meter → фиксированной суммы коммуналки тоже нет.
    expect(screen.queryByRole('option', { name: /Фиксированная сумма коммунальных/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('option', { name: /Плата в месяц/ }));
    const before = screen.getByTestId('real-revision-before') as HTMLInputElement;
    expect(before.value).not.toBe('');

    fireEvent.change(screen.getByTestId('real-revision-after'), { target: { value: '170000.00' } });
    await userEvent.click(screen.getByTestId('real-submit-revision'));

    // Мок-бэк принял адрес `form.rent_amount` (раньше — 422 revision_item_unknown).
    const revision = await screen.findByTestId('real-revision');
    expect(within(revision).getByTestId('real-revision-item-label')).toHaveTextContent('Плата в месяц');
    expect(within(revision).getByText('открыта')).toBeInTheDocument();
  });

  it('продажа: choice-поле категории отдаётся списком вариантов, а не свободной строкой', async () => {
    renderPage('/contracts/rc-sale-review-1');
    await screen.findByText('Продажа велосипеда');
    await openCardTab('negoSign');
    await userEvent.click(await screen.findByTestId('real-propose-revision'));

    await pickRevisionItem(/Категория товара/);
    // type=choice из схемы → select со всеми 18 категориями бэка.
    const after = screen.getByTestId('real-revision-after');
    expect(after.tagName).toBe('SELECT');
    expect(within(after).getAllByRole('option').length).toBeGreaterThanOrEqual(18);
  });

  it('заём: поля схемы loan подписаны, условно скрытый график платежей не предлагается', async () => {
    renderPage('/contracts/rc-loan-review-1');
    await screen.findByText('Заём на ремонт');
    await openCardTab('negoSign');
    await userEvent.click(await screen.findByTestId('real-propose-revision'));

    await openRevisionItems();
    await screen.findByRole('option', { name: /Сумма займа/ });
    // repayment_type=lump_sum → «График платежей» скрыт условием.
    expect(screen.queryByRole('option', { name: /График платежей/ })).not.toBeInTheDocument();
  });
});

/**
 * Замечание тестеров 27.08 «в окне займа нет кнопки „Предложить правку“».
 * Разбор 28.08: кнопка зависит ТОЛЬКО от negotiation_status=under_review
 * (tech-spec §6.1), роль зрителя на неё не влияет. Раньше это правило нигде
 * не было закреплено тестом — проверялся только положительный случай от лица
 * заказчика, поэтому регресс «кнопка пропала/появилась не в том статусе»
 * прошёл бы незамеченным.
 */
describe('Кнопка «Предложить правку» — зависимость от статуса и роли', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('draft: раздел согласования есть, кнопки правок нет — договор ещё не отправлен', async () => {
    renderPage('/contracts/rc-draft-1');
    await screen.findByText('Ремонт крана на кухне');
    await openCardTab('negoSign');

    // Раздел существует и достижим: `openCardTab` упал бы, не найди он
    // «Переговоры и подписи» среди категорий воронки (DEV-20_2 §3).
    expect(screen.queryByTestId('real-propose-revision')).not.toBeInTheDocument();
    // Вместо пустой вкладки — объяснение, почему кнопки нет. В черновике
    // подписывать нечего, поэтому ссылки на подписание быть не должно.
    expect(await screen.findByTestId('nego-closed-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('nego-closed-to-signing')).not.toBeInTheDocument();
  });

  it('pending_signature: после заморозки правок нет — только возврат с экрана подписания', async () => {
    renderPage('/contracts/rc-frozen-1');
    await screen.findByText('Установка окон');
    await openCardTab('negoSign');

    // Раздел существует и достижим: `openCardTab` упал бы, не найди он
    // «Переговоры и подписи» среди категорий воронки (DEV-20_2 §3).
    expect(screen.queryByTestId('real-propose-revision')).not.toBeInTheDocument();
    // Здесь возврат существует (ADR-124), поэтому подсказка ведёт на подписание.
    expect(await screen.findByTestId('nego-closed-hint')).toBeInTheDocument();
    expect(screen.getByTestId('nego-closed-to-signing')).toHaveAttribute(
      'href',
      '/contracts/rc-frozen-1/sign',
    );
  });

  it('under_review: кнопка видна и второй стороне — правки не привилегия инициатора', async () => {
    // rc-review-1 создан заказчиком (pf-person-1); смотрим глазами исполнителя.
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-review-1');
    await openNegoTab();

    expect(await screen.findByTestId('real-propose-revision')).toBeInTheDocument();
    // На согласовании объяснять нечего — подсказка не должна отбирать место у правок.
    expect(screen.queryByTestId('nego-closed-hint')).not.toBeInTheDocument();
  });
});
