import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createI18n } from '@porukam/i18n';
import {
  CONTRACT_NEW_STORAGE_KEY,
  useContractNewStore,
} from '../src/features/contractNew/draftStore';
import { PartiesStepPage } from '../src/pages/contract-new/PartiesStepPage';

/**
 * Отсмотр 2026-08-23: F5/выгрузка PWA посреди мастера обнуляли draftStore —
 * на «Сторонах» терялся выбранный тип, и создание черновика падало с 400
 * «нужен client_option или contract_type_code». Два рубежа защиты:
 * персист стора в localStorage + редирект на шаг «Тип», если типа всё же нет.
 */

function renderParties(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={createI18n('ru')}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/contracts/new/parties']}>
          {/* Шаги — вложенные под-маршруты, как в router.tsx: иначе относительный
              `../type` из гарда резолвится не туда. */}
          <Routes>
            <Route path="/contracts/new">
              <Route path="parties" element={<PartiesStepPage />} />
              <Route path="type" element={<div data-testid="type-step" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe('Персист мастера договора', () => {
  beforeEach(() => {
    useContractNewStore.getState().reset();
    localStorage.removeItem(CONTRACT_NEW_STORAGE_KEY);
  });

  it('выбор типа переживает перезагрузку (localStorage + rehydrate)', async () => {
    useContractNewStore.getState().setClientOption('rent');
    useContractNewStore.getState().setContractTypeCode('rent_flat');

    const raw = localStorage.getItem(CONTRACT_NEW_STORAGE_KEY);
    expect(raw).toContain('rent_flat');

    // «Перезагрузка»: память обнулилась, хранилище — нет. setState тоже идёт
    // через persist-мидлварь, поэтому снимок хранилища возвращаем перед rehydrate.
    const snapshot = raw ?? '';
    useContractNewStore.setState({ clientOption: null, contractTypeCode: null });
    localStorage.setItem(CONTRACT_NEW_STORAGE_KEY, snapshot);
    await useContractNewStore.persist.rehydrate();
    expect(useContractNewStore.getState().clientOption).toBe('rent');
    expect(useContractNewStore.getState().contractTypeCode).toBe('rent_flat');
  });

  it('reset() чистит и память, и localStorage', () => {
    useContractNewStore.getState().setClientOption('service');
    useContractNewStore.getState().reset();
    expect(useContractNewStore.getState().clientOption).toBeNull();
    const raw = localStorage.getItem(CONTRACT_NEW_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('service');
  });

  it('«Стороны» без типа и черновика — редирект на шаг «Тип»', async () => {
    renderParties();
    await waitFor(() => expect(screen.getByTestId('type-step')).toBeInTheDocument());
  });

  it('«Стороны» с выбранным типом — редиректа нет', async () => {
    useContractNewStore.getState().setClientOption('service');
    renderParties();
    expect(await screen.findByText('Кто стороны договора')).toBeInTheDocument();
    expect(screen.queryByTestId('type-step')).not.toBeInTheDocument();
  });

  it('префилл ?counterparty=@handle — контрагент ВЫБИРАЕТСЯ сам, «Далее» активна (отсмотр 2026-08-24)', async () => {
    useContractNewStore.getState().setClientOption('service');
    useContractNewStore.getState().setCounterpartyPrefill('@masterremont');
    renderParties();
    // Автовыбор: точное совпадение хендла из результатов поиска подтянулось само.
    await waitFor(() =>
      expect(useContractNewStore.getState().counterparty?.handle).toBe('@masterremont'),
    );
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
  });
});
