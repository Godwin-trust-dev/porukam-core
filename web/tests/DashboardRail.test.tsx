import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import type { RealContract } from '@porukam/core';
import { DashboardRail, activeTotalsByCurrency } from '../src/features/dashboard/DashboardRail';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/** Минимальный договор — рейлу хватает статусов, сторон и суммы. */
function contract(patch: Partial<RealContract> & { id: string }): RealContract {
  return {
    contract_type_code: 'services_individual',
    deal_type: 'c2c',
    segment: 'free_c2c',
    negotiation_status: 'signed',
    execution_status: null,
    payment_method: 'cash',
    protected: false,
    uses_platform_template: true,
    jurisdiction: 'RU',
    title: patch.id,
    form_data: {},
    additional_terms: [],
    warnings: [],
    language: 'ru',
    parties: [
      { id: `${patch.id}-p1`, role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
      { id: `${patch.id}-p2`, role: 'contractor', profile_id: 'pf-person-2', entity_id: null, acting_as: 'person' },
    ],
    total: null,
    initiator_role: 'customer',
    frozen_version_id: null,
    created_at: '2026-08-01T00:00:00Z',
    last_activity_at: '2026-08-01T00:00:00Z',
    ...patch,
  } as RealContract;
}

function Where(): JSX.Element {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{`${pathname}${search}`}</div>;
}

function renderRail(contracts: RealContract[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<DashboardRail contracts={contracts} />} />
            <Route path="/contracts" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const CONTRACTS = [
  contract({ id: 'rc-a', execution_status: 'in_progress', total: { amount: '1000.00', currency: 'RUB' } }),
  contract({ id: 'rc-b', execution_status: 'in_progress', total: { amount: '500.00', currency: 'RUB' } }),
  contract({ id: 'rc-done', execution_status: 'completed' }),
];

/**
 * Денежная рамка рабочего стола (DEV-19 §3): суммы по валютам + счётчики
 * «Активные»/«Архив». Решение владельца 05.09 — счётчики кликабельны и ведут
 * на соответствующую вкладку «Сделок» (`ContractsListPage` выбирает вкладку
 * по `?tab=`, «активные» — состояние по умолчанию, то есть без параметра).
 */
describe('DashboardRail — счётчики денежной рамки', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
  });

  it('суммы активных — по валютам, завершённые не считаются', () => {
    expect(activeTotalsByCurrency(CONTRACTS)).toEqual([{ amount: '1500.00', currency: 'RUB' }]);
  });

  it('«Активные» и «Архив» — ссылки, числа рядом с ними не меняются', () => {
    renderRail(CONTRACTS);
    const active = screen.getByRole('link', { name: 'Активные' });
    const archive = screen.getByRole('link', { name: 'Архив' });
    expect(active).toHaveAttribute('href', '/contracts');
    expect(archive).toHaveAttribute('href', '/contracts?tab=archive');
    // Счётчики остаются числами возле подписей: 2 активных, 1 в архиве.
    expect(active.closest('div')).toHaveTextContent('2');
    expect(archive.closest('div')).toHaveTextContent('1');
  });

  it('«Архив» открывает список на вкладке архива', async () => {
    renderRail(CONTRACTS);
    await userEvent.click(screen.getByRole('link', { name: 'Архив' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/contracts?tab=archive');
  });

  it('«Активные» открывает список на вкладке по умолчанию (без ?tab=)', async () => {
    renderRail(CONTRACTS);
    await userEvent.click(screen.getByRole('link', { name: 'Активные' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/contracts');
    expect(screen.getByTestId('where')).not.toHaveTextContent('tab=');
  });

  it('переход достижим с клавиатуры (ссылка в табуляции, Enter срабатывает)', async () => {
    renderRail(CONTRACTS);
    const archive = screen.getByRole('link', { name: 'Архив' });
    archive.focus();
    expect(archive).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('where')).toHaveTextContent('/contracts?tab=archive');
  });
});
