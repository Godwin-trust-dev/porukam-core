import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import type { RealContract } from '@porukam/core';
import { DashboardPage } from '../src/pages/DashboardPage';
import { bucketOf, compareByStatus } from '../src/features/contracts/realStatus';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/contracts" element={<div data-testid="list-stub">list</div>} />
            <Route path="/contracts/:id" element={<div data-testid="detail-stub">detail</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Минимальный договор для чистых проверок корзины и сортировки. */
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
    // Без своей стороны карточка оборонительно не рисуется (RealContractTile).
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

/**
 * Замечание владельца 28.08: рабочий стол показывал ВСЕ сделки — черновики,
 * отклонённые и архивные вперемешку с работой. Решение 31.08 по гарантии:
 * гарантийный период — архив, но открытый гарантийный случай возвращает
 * сделку в активные, а его закрытие уносит обратно.
 */
describe('Активные сделки: корзина и сортировка по статусу', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('⭐ гарантийный период — архив, пока по нему не открыт гарантийный случай', () => {
    const c = contract({ id: 'rc-warranty-1', execution_status: 'warranty' });
    expect(bucketOf(c)).toBe('archive');
    expect(bucketOf(c, new Set<string>())).toBe('archive');
    expect(bucketOf(c, new Set(['rc-warranty-1']))).toBe('active');
    // Закрыли заявку — множество пустеет, сделка сама уходит обратно в архив.
    expect(bucketOf(c, new Set(['другой-договор']))).toBe('archive');
  });

  it('гарантийное исключение не трогает остальные корзины', () => {
    const claims = new Set(['rc-draft-1', 'rc-rejected-1', 'rc-done-1']);
    expect(bucketOf(contract({ id: 'rc-draft-1', negotiation_status: 'draft' }), claims)).toBe('drafts');
    expect(bucketOf(contract({ id: 'rc-rejected-1', negotiation_status: 'rejected_by_counterparty' }), claims)).toBe('archive');
    expect(bucketOf(contract({ id: 'rc-done-1', execution_status: 'completed' }), claims)).toBe('archive');
  });

  it('сортировка по статусу: терминальные не мешаются с завершёнными, внутри статуса — свежие сверху', () => {
    const rows = [
      contract({ id: 'terminated', execution_status: 'terminated_by_customer' }),
      contract({ id: 'completed-old', execution_status: 'completed', created_at: '2026-07-01T00:00:00Z' }),
      contract({ id: 'rejected', negotiation_status: 'rejected_by_counterparty' }),
      contract({ id: 'warranty', execution_status: 'warranty' }),
      contract({ id: 'completed-new', execution_status: 'completed', created_at: '2026-08-20T00:00:00Z' }),
    ];
    expect([...rows].sort(compareByStatus).map((c) => c.id)).toEqual([
      'warranty',
      'completed-new',
      'completed-old',
      'rejected',
      'terminated',
    ]);
  });

  /** Детерминированный список: превью ограничено пятью карточками, поэтому
      проверять фильтр на общем сиде (там активных заведомо больше пяти)
      значило бы проверять срез, а не корзину. */
  const SMALL_LIST = [
    contract({ id: 'rc-draft-x', negotiation_status: 'draft', title: 'Черновик — кран' }),
    contract({ id: 'rc-rejected-x', negotiation_status: 'rejected_by_counterparty', title: 'Отклонён — забор' }),
    contract({ id: 'rc-warranty-x', execution_status: 'warranty', title: 'Гарантия — ламинат' }),
    contract({ id: 'rc-progress-x', execution_status: 'in_progress', title: 'В работе — ванная' }),
  ];

  function useSmallList(claims: unknown[] = []): void {
    server.use(
      http.get('/v1/contracts', () => HttpResponse.json(SMALL_LIST)),
      http.get('/v1/warranty-claims', () => HttpResponse.json(claims)),
      http.get('/v1/dashboard', () => HttpResponse.json({ attention: [] })),
    );
  }

  const OPEN_CLAIM = {
    id: 'wc-open-1',
    contract_id: 'rc-warranty-x',
    submitted_by_id: 'u-1',
    description: 'Вздулся стык',
    evidence: [],
    status: 'submitted',
    resolution_type: '',
    dispute_id: null,
    submitted_at: '2026-08-30T10:00:00Z',
    resolved_at: null,
    fix_rounds_used: 0,
    fix_rounds_left: 2,
    acceptance_deadline_at: null,
    fixes: [],
    resolved_by_id: null,
    resolved_auto: false,
  };

  it('⭐ рабочий стол: черновик, отклонённый и гарантийный период в превью не попадают', async () => {
    useSmallList();
    renderDashboard();
    const list = await screen.findByTestId('dashboard-contracts');
    expect(await within(list).findByText('В работе — ванная')).toBeInTheDocument();
    expect(within(list).queryByText('Черновик — кран')).not.toBeInTheDocument();
    expect(within(list).queryByText('Отклонён — забор')).not.toBeInTheDocument();
    expect(within(list).queryByText('Гарантия — ламинат')).not.toBeInTheDocument();
    // Черновики и архив никуда не делись — до них ведёт «Все сделки».
    expect(screen.getByRole('button', { name: 'Все сделки' })).toBeInTheDocument();
  });

  it('⭐ открыт гарантийный случай — сделка возвращается на рабочий стол', async () => {
    useSmallList([OPEN_CLAIM]);
    renderDashboard();
    const list = await screen.findByTestId('dashboard-contracts');
    expect(await within(list).findByText('Гарантия — ламинат')).toBeInTheDocument();
  });

  it('заявка закрыта — сделка снова в архиве, на рабочем столе её нет', async () => {
    useSmallList([{ ...OPEN_CLAIM, status: 'resolved', resolution_type: 'warranty_satisfied', resolved_at: '2026-08-31T09:00:00Z' }]);
    renderDashboard();
    const list = await screen.findByTestId('dashboard-contracts');
    expect(await within(list).findByText('В работе — ванная')).toBeInTheDocument();
    expect(within(list).queryByText('Гарантия — ламинат')).not.toBeInTheDocument();
  });
});
