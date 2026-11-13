import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import {
  ContractPage,
  ContractOverviewTab,
  ContractStagesTab,
  ContractMoneyTab,
  ContractHistoryTab,
} from '../src/pages/ContractPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useViewerStore } from '../src/features/contracts/viewerStore';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id" element={<ContractPage />}>
              <Route path="overview" element={<ContractOverviewTab />} />
              <Route path="stages" element={<ContractStagesTab />} />
              <Route path="money" element={<ContractMoneyTab />} />
              <Route path="history" element={<ContractHistoryTab />} />
            </Route>
            <Route path="/:handle" element={<div>карточка контрагента</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('ContractPage (DEV-06) — приёмка §11', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      {
        id: 'pf-viewer',
        kind: 'person',
        display_name: 'Смотрящий',
        handle: '@viewer',
        verification_level: 'basic',
        has_business_status: false,
      },
    ]);
    useViewerStore.getState().setViewAs('customer');
  });

  it('заказчик: видит «Примите этап» + [Принять], один статус-чип, «Оплачено»/«Остаток»', async () => {
    renderPage('/contracts/c-4001/overview');
    expect(await screen.findByText(/ждёт вашей приёмки/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Принять' })).toBeInTheDocument();
    expect(screen.getAllByTestId('contract-status')).toHaveLength(1);
    expect(screen.getByText('Оплачено')).toBeInTheDocument();
    expect(screen.getByText('Остаток')).toBeInTheDocument();
    expect(screen.queryByText('Получено')).not.toBeInTheDocument();
    expect(screen.queryByText('Ожидается')).not.toBeInTheDocument();
  });

  it('исполнитель: на том же договоре видит инфо-режим (без кнопки принятия) + [Напомнить]', async () => {
    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-4001/overview');
    expect(await screen.findByText(/Ждём приёмку этапа/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Напомнить' })).toBeInTheDocument();
  });

  it('контент вкладки «Этапы» одинаков у обеих ролей', async () => {
    renderPage('/contracts/c-4001/stages');
    const customerStages = (await screen.findAllByTestId('stage-tree'))[0]?.textContent;

    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-4001/stages');
    const contractorStages = (await screen.findAllByTestId('stage-tree')).at(-1)?.textContent;

    expect(customerStages).toBe(contractorStages);
  });

  it('клик по имени контрагента открывает его карточку', async () => {
    renderPage('/contracts/c-4001/overview');
    await screen.findByTestId('contract-header');
    await userEvent.click(screen.getByTestId('counterparty-link'));
    expect(await screen.findByText('карточка контрагента')).toBeInTheDocument();
  });

  it('вкладка «Деньги» — заключение бесплатно (финмодель v2), без литералов в разметке', async () => {
    renderPage('/contracts/c-4001/money');
    expect(await screen.findByText('Заключение договора — бесплатно')).toBeInTheDocument();
    expect(screen.getAllByText('Оплачено').length).toBeGreaterThan(0);
    expect(screen.getByText('Остаток')).toBeInTheDocument();
  });

  it('вкладка «История» — допников нет → пояснение', async () => {
    renderPage('/contracts/c-4001/history');
    expect(await screen.findByText('Допников пока нет')).toBeInTheDocument();
  });
});
