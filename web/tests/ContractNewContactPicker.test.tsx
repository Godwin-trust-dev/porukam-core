import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { createI18n } from '@porukam/i18n';
import { server } from '../src/mocks/server';
import { useAuthStore } from '../src/features/auth/authStore';
import { CONTRACT_NEW_STORAGE_KEY, useContractNewStore } from '../src/features/contractNew/draftStore';
import { PartiesStepPage } from '../src/pages/contract-new/PartiesStepPage';
import { normalizeCounterpartyInput } from '../src/features/contacts/handleInput';

/**
 * Книга контактов на шаге «Стороны» (решение владельца 05.09: «Вторая сторона
 * пусть открывается при нажатии книга контактов, и можно было выбрать из
 * сохранённых (предусмотри поиск сразу) или вставить хендл»).
 *
 * Мок-справочник (`profileDb.seedContacts`) сидируется из `handleDirectory`:
 * `@masterremont` (из договора), `@irina_s` (вручную) и «Мария Соколова» без
 * хендла (телефонная книга) — поэтому здесь проверяется и то, что контакт без
 * хендла контрагентом не становится.
 */

function renderParties(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={createI18n('ru')}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/contracts/new/parties']}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="parties" element={<PartiesStepPage />} />
              <Route path="type" element={<div data-testid="type-step" />} />
              <Route path="details" element={<div data-testid="details-step" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe('Шаг «Стороны» — книга контактов', () => {
  beforeEach(() => {
    localStorage.removeItem(CONTRACT_NEW_STORAGE_KEY);
    useContractNewStore.getState().reset();
    useContractNewStore.getState().setClientOption('service');
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  });

  it('кнопка «Из контактов» открывает шит со списком сохранённых', async () => {
    renderParties();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('open-contacts'));

    const list = await screen.findByTestId('contacts-picker-list');
    expect(list).toBeInTheDocument();
    expect(await screen.findByTestId('contacts-picker-@masterremont')).toBeInTheDocument();
    expect(screen.getByTestId('contacts-picker-@irina_s')).toBeInTheDocument();
    // Поиск в шите получает фокус сразу — печатать можно, не целясь в поле.
    expect(screen.getByTestId('contacts-picker-search')).toHaveFocus();
  });

  it('контакт без @хендла — приглушён, последним в списке и не выбирается', async () => {
    renderParties();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('open-contacts'));

    const row = await screen.findByTestId('contacts-picker-contact-masha');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveTextContent('нет @хендла — договор заключить нельзя');

    // Строки с хендлом идут первыми — приглушённая замыкает список.
    const rows = Array.from(screen.getByTestId('contacts-picker-list').children);
    expect(rows.at(-1)).toBe(row);

    // Тап ничего не делает: шит открыт, контрагент не выбран.
    await user.click(row);
    expect(screen.getByTestId('contacts-picker-search')).toBeInTheDocument();
    expect(useContractNewStore.getState().counterparty).toBeNull();
  });

  it('поиск фильтрует справочник по имени и по @хендлу с первого символа', async () => {
    renderParties();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('open-contacts'));
    await screen.findByTestId('contacts-picker-@masterremont');

    // По имени.
    await user.type(screen.getByTestId('contacts-picker-search'), 'Ирина');
    await waitFor(() => expect(screen.queryByTestId('contacts-picker-@masterremont')).not.toBeInTheDocument());
    expect(screen.getByTestId('contacts-picker-@irina_s')).toBeInTheDocument();

    // По хендлу — регистр не важен, «собачка» необязательна.
    await user.clear(screen.getByTestId('contacts-picker-search'));
    await user.type(screen.getByTestId('contacts-picker-search'), 'MASTER');
    await waitFor(() => expect(screen.queryByTestId('contacts-picker-@irina_s')).not.toBeInTheDocument());
    expect(screen.getByTestId('contacts-picker-@masterremont')).toBeInTheDocument();
  });

  it('тап по контакту закрывает шит и заполняет поле «Вторая сторона»', async () => {
    renderParties();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('open-contacts'));

    await user.click(await screen.findByTestId('contacts-picker-@masterremont'));

    await waitFor(() => expect(screen.queryByTestId('contacts-picker-search')).not.toBeInTheDocument());
    expect(screen.getByTestId('counterparty-search')).toHaveValue('Мастер Ремонт');
    expect(useContractNewStore.getState().counterparty?.handle).toBe('@masterremont');
    expect(screen.getByTestId('wizard-next')).toBeEnabled();
  });

  it('фильтр без результата предлагает поиск на платформе — и он идёт в том же шите', async () => {
    renderParties();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('open-contacts'));
    await screen.findByTestId('contacts-picker-@masterremont');

    // «@svetdom» есть на платформе, но НЕ в справочнике.
    await user.type(screen.getByTestId('contacts-picker-search'), 'svetdom');
    const cta = await screen.findByTestId('contacts-picker-search-platform');
    expect(cta).toHaveTextContent('Искать @svetdom на платформе');

    await user.click(cta);
    await user.click(await screen.findByTestId('contacts-picker-handle-@svetdom'));

    expect(screen.getByTestId('counterparty-search')).toHaveValue('ООО «СветДом»');
    expect(useContractNewStore.getState().counterparty?.handle).toBe('@svetdom');
  });

  it('пустой справочник — своё состояние с подсказкой про вставку хендла', async () => {
    server.use(http.get('/v1/users/me/contacts', () => HttpResponse.json([])));
    renderParties();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('open-contacts'));

    expect(await screen.findByText('Сохранённых контактов пока нет')).toBeInTheDocument();
    expect(screen.getByText('Вставьте @хендл в поле.')).toBeInTheDocument();
    expect(screen.queryByTestId('contacts-picker-list')).not.toBeInTheDocument();
  });

  it('поиск по хендлу помечает «в контактах» и предлагает сохранить нового контрагента', async () => {
    renderParties();
    const user = userEvent.setup();

    // Сохранённый — пометка есть.
    await user.type(await screen.findByTestId('counterparty-search'), 'Мастер');
    const savedRow = await screen.findByTestId('handle-@masterremont');
    expect(savedRow).toHaveTextContent('в контактах');
    await user.click(savedRow);
    expect(await screen.findByTestId('counterparty-saved')).toBeInTheDocument();

    // Не сохранённый — ссылка «Сохранить в контакты».
    await user.clear(screen.getByTestId('counterparty-search'));
    await user.type(screen.getByTestId('counterparty-search'), 'СветДом');
    const freshRow = await screen.findByTestId('handle-@svetdom');
    expect(freshRow).not.toHaveTextContent('в контактах');
    await user.click(freshRow);

    await user.click(await screen.findByTestId('save-counterparty-contact'));
    expect(await screen.findByTestId('counterparty-saved')).toBeInTheDocument();
  });
});

describe('Вставка в поле «Вторая сторона»', () => {
  it.each([
    ['@masterremont', '@masterremont'],
    ['porukam.app/@masterremont', '@masterremont'],
    ['https://porukam.app/@masterremont', '@masterremont'],
    ['https://www.porukam.app/masterremont?utm_source=chat', '@masterremont'],
    ['  https://porukam.app/@masterremont#top  ', '@masterremont'],
    ['Мастер Ремонт', 'Мастер Ремонт'],
    ['', ''],
  ])('«%s» → «%s»', (input, expected) => {
    expect(normalizeCounterpartyInput(input)).toBe(expected);
  });
});
