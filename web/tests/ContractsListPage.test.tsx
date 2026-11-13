import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ContractsListPage } from '../src/pages/ContractsListPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { setProfileAvatar } from '../src/mocks/profilesDb';

function renderPage(path = '/contracts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts" element={<ContractsListPage />} />
            <Route path="/contracts/new/*" element={<div data-testid="wizard-stub">wizard</div>} />
            <Route path="/contracts/:id" element={<div data-testid="detail-stub">detail</div>} />
            <Route path="/reputation/profiles/:profileId" element={<div data-testid="reputation-stub">reputation</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * Категория списка «Черновики»/«Все» переехала из вкладок в шит по воронке
 * (DEV-20_2 §3: в строке вкладок только «Активные» и «Архив»). Хелпер делает
 * то же, что человек: открыть воронку → выбрать категорию → закрыть шит.
 */
async function pickCategory(value: string): Promise<void> {
  // Решение владельца 03.09: «Активные · Черновики · Архив» — три вкладки;
  // в воронке остаётся только «Все».
  if (value === 'active' || value === 'drafts' || value === 'archive') {
    await userEvent.click(await screen.findByTestId(`tab-${value}`));
    return;
  }
  await userEvent.click(await screen.findByTestId('open-filters'));
  await userEvent.selectOptions(await screen.findByTestId('filters-category'), value);
  await userEvent.click(screen.getByTestId('filters-apply'));
}

/**
 * DEV-13, Фаза 1 (ADR-088) — реальный `GET /v1/contracts`, `realContractsDb.ts`
 * (`pf-person-1` — свой актёр: заказчик в rc-draft-1/rc-review-1/rc-rejected-1,
 * исполнитель в rc-progress-1 — «микс ролей»). Сфера/статус/способ-оплаты как
 * ОТДЕЛЬНЫЕ фильтры сняты Фазой 1 (нет каталога/бэкенд-фильтра) — соответствующие
 * старые приёмки (2, 6 по старому счёту) здесь не воспроизводятся 1:1.
 */
describe('ContractsListPage (DEV-13, реальный контур — Фаза 1)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('⭐ по умолчанию: вкладка «Активные», виден микс ролей (приёмка 1)', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: /Активные/ })).toHaveAttribute('aria-selected', 'true');
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));

    const rows = within(list).getAllByTestId('contract-list-row');
    const roleTexts = rows.map((r) => r.textContent ?? '');
    const hasCustomer = roleTexts.some((t) => t.includes('вы заказчик'));
    const hasContractor = roleTexts.some((t) => t.includes('вы исполнитель'));
    expect(hasCustomer).toBe(true);
    expect(hasContractor).toBe(true);
  });

  it('категория «Черновики» (воронка) показывает только черновик', async () => {
    renderPage();
    await pickCategory('drafts');
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBe(1));
    expect(within(list).getByText('Ремонт крана на кухне')).toBeInTheDocument();
  });

  it('вкладка «Архив» показывает отклонённый договор приглушённым, с группой «Не состоялись и терминальные»', async () => {
    renderPage();
    await screen.findByTestId('contracts-list');
    await userEvent.click(screen.getByRole('tab', { name: /Архив/ }));

    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    expect(screen.getByText('Не состоялись и терминальные')).toBeInTheDocument();
    const row = within(list).getByText('Покраска забора').closest('[data-testid="contract-list-row"]');
    expect(row).toHaveAttribute('data-status', 'rejected_by_counterparty');
  });

  it('фильтр роли сужает список; «Сбросить» возвращает всех (приёмка 5)', async () => {
    renderPage();
    // «Все», чтобы увидеть обе роли одновременно (rc-progress-1 — исполнитель).
    await pickCategory('all');
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    const totalBefore = within(list).getAllByTestId('contract-list-row').length;

    // DEV-20_2 §3: роль и сортировка живут в шите по воронке на ВСЕХ ширинах —
    // инлайновых селектов над списком больше нет, вход в фильтры один.
    await userEvent.click(screen.getByTestId('open-filters'));
    await userEvent.selectOptions(screen.getByLabelText('Роль'), 'contractor');
    await userEvent.click(screen.getByTestId('filters-apply'));
    await waitFor(() => {
      const rows = within(screen.getByTestId('contracts-list')).getAllByTestId('contract-list-row');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => (r.textContent ?? '').includes('вы исполнитель'))).toBe(true);
    });

    // «Сбросить» само закрывает шторку (замечание владельца 03.09) —
    // второго действия «Выбрать» после сброса больше нет.
    await userEvent.click(screen.getByTestId('open-filters'));
    await userEvent.click(screen.getByTestId('filters-reset'));
    expect(screen.queryByTestId('filters-apply')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(within(screen.getByTestId('contracts-list')).getAllByTestId('contract-list-row').length).toBe(totalBefore);
    });
  });

  it('поиск по названию сужает список; без совпадений — пусто', async () => {
    renderPage();
    await pickCategory('all');
    await screen.findByTestId('contracts-list');
    await userEvent.type(screen.getByPlaceholderText('Контрагент, название, №'), 'Ремонт ванной');
    await waitFor(() => {
      const rows = within(screen.getByTestId('contracts-list')).getAllByTestId('contract-list-row');
      expect(rows.length).toBe(1);
    });

    await userEvent.clear(screen.getByPlaceholderText('Контрагент, название, №'));
    await userEvent.type(screen.getByPlaceholderText('Контрагент, название, №'), 'zzz-нет-такого-договора-zzz');
    expect(await screen.findByText('Ничего не найдено', {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('строка показывает сумму и имя контрагента, резолвленное реальным профилем', async () => {
    renderPage();
    await pickCategory('all');
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    // pf-mock-contractor-1 — «Марат Отделкин» (profilesDb.ts), резолвится отдельным GET /profiles/{id}.
    expect(await within(list).findAllByText('Марат Отделкин')).not.toHaveLength(0);
  });

  it('«Копировать» создаёт новый договор через реальный POST /contracts и открывает его', async () => {
    renderPage();
    await pickCategory('all');
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));

    const row = within(list).getByText('Сборка мебели — гостиная').closest('[data-testid="contract-row-swipe"]') as HTMLElement;
    await userEvent.click(within(row).getAllByLabelText('Действия', { selector: 'button' }).at(-1)!);
    await userEvent.click(screen.getByRole('button', { name: 'Копировать' }));

    expect(await screen.findByTestId('detail-stub')).toBeInTheDocument();
  });

  // Отсмотр 2026-08-21 + DEV-20_2 §2: «⋯» в строке нет — тот же список
  // действий приходит долгим тапом/свайпом (`SwipeActions`), а клавиатуре его
  // отдаёт скрытая кнопка «Действия».
  it('меню черновика: Открыть, «Копировать», Удалить; у не-черновика «Удалить» нет', async () => {
    renderPage();
    await pickCategory('drafts');
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBe(1));
    const draftRow = within(list).getAllByTestId('contract-row-swipe')[0]!;
    await userEvent.click(within(draftRow).getAllByLabelText('Действия', { selector: 'button' }).at(-1)!);
    expect(screen.getByRole('button', { name: 'Открыть' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Копировать' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('tab', { name: /Архив/ }));
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    const archiveRow = within(list).getAllByTestId('contract-row-swipe')[0]!;
    await userEvent.click(within(archiveRow).getAllByLabelText('Действия', { selector: 'button' }).at(-1)!);
    expect(screen.getByRole('button', { name: 'Копировать' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
  });

  it('«Удалить» черновик из меню → подтверждение → DELETE, строка исчезает', async () => {
    renderPage();
    await pickCategory('drafts');
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBe(1));
    const draftRow = within(list).getAllByTestId('contract-row-swipe')[0]!;
    await userEvent.click(within(draftRow).getAllByLabelText('Действия', { selector: 'button' }).at(-1)!);
    await userEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    await userEvent.click(await screen.findByTestId('row-delete-draft-confirm'));
    await waitFor(() => expect(within(list).queryByText('Ремонт крана на кухне')).not.toBeInTheDocument());
  });

  /**
   * Замечание владельца 2026-09-08 (скриншот `Screenshot_20260907_205303_Chrome.jpg`):
   * «не отражается фото напротив договора» — в строке рисовались инициалы, хотя
   * у контрагента загружено фото. Источник — тот же `GET /profiles/{id}`, которым
   * строка уже резолвит имя: `avatar_url` он отдаёт и для ЧУЖОГО профиля
   * (ADR-103). Мок-набор аватаров не содержит (сид — `avatar_url: null`, картинки
   * не выдумываем), поэтому фото заводим тем же путём, что человек, — «загрузкой»;
   * `resetProfilesDb()` в `tests/setup.ts` откатывает его после теста.
   */
  it('⭐ фото контрагента показывается в строке списка, когда оно у него есть', async () => {
    const { avatar_url } = setProfileAvatar('pf-mock-contractor-1', new Uint8Array([1, 2, 3]), 'image/png');
    renderPage();
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    const row = within(list).getAllByTestId('contract-list-row')[0]!;
    // Аватар декоративен (`alt=""`, рядом имя текстом) — ищем сам <img>, не роль.
    await waitFor(() => expect(row.querySelector('img')).not.toBeNull());
    expect(row.querySelector('img')).toHaveAttribute('src', avatar_url!);
  });

  it('без фото контрагента строка остаётся с инициалами (мок-сид)', async () => {
    renderPage();
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    const row = within(list).getAllByTestId('contract-list-row')[0]!;
    await waitFor(() => expect(within(row).getByTestId('row-counterparty')).not.toHaveTextContent('…'));
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).getByText('МО')).toBeInTheDocument();
  });

  // Отсмотр 2026-08-21: контрагент в строке → его карточка репутации (ADR-093).
  it('клик по имени контрагента в строке открывает карточку репутации, а не договор', async () => {
    renderPage();
    const list = await screen.findByTestId('contracts-list');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    const row = within(list).getAllByTestId('contract-list-row')[0]!;
    const counterparty = within(row).getByTestId('row-counterparty');
    await waitFor(() => expect(counterparty).not.toHaveTextContent('…'));
    await userEvent.click(counterparty);
    expect(await screen.findByTestId('reputation-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-stub')).not.toBeInTheDocument();
  });
});
