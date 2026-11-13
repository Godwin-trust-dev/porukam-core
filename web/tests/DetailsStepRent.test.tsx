import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { DetailsStepPage } from '../src/pages/contract-new/DetailsStepPage';
import {
  CONTRACT_NEW_STORAGE_KEY,
  useContractNewStore,
} from '../src/features/contractNew/draftStore';
import { useAuthStore } from '../src/features/auth/authStore';
import { server } from '../src/mocks/server';

/**
 * Отсмотр 2026-08-23, аренда на шаге «Суть»:
 * 1) «не пропускает, хотя всё заполнено» — заблокированное «Далее» молчало;
 *    теперь под формой подсказка «Осталось заполнить: …» с именами полей;
 * 2) «идёшь на шаг назад — введённое пропадает» — значения шага автосейвятся
 *    в draftStore на каждый ввод и восстанавливаются при возврате.
 */

const DRAFT_ID = 'rc-rent-test';

// Срез реальной схемы rent_items (apps.contracts.forms) — обязательные поля
// трёх секций + условная видимость end_date.
const RENT_SCHEMA = {
  code: 'rent_items',
  schema_version: 1,
  sections: [
    {
      key: 'item',
      title_i18n_key: 'contract_forms.rent_items.section.item',
      external_entity: null,
      fields: [
        { key: 'item_name', type: 'string', required: true, default: null, choices: null, min_value: null, max_value: null, condition: null, hint_i18n_key: null, kv_block: 'V-RENT' },
        { key: 'item_identification', type: 'text', required: true, default: null, choices: null, min_value: null, max_value: null, condition: null, hint_i18n_key: null, kv_block: 'V-RENT' },
      ],
    },
    {
      key: 'term',
      title_i18n_key: 'contract_forms.rent_items.section.term',
      external_entity: null,
      fields: [
        { key: 'term_type', type: 'choice', required: true, default: null, choices: ['date_range', 'daily'], min_value: null, max_value: null, condition: null, hint_i18n_key: null, kv_block: 'K4' },
        { key: 'start_date', type: 'date', required: true, default: null, choices: null, min_value: null, max_value: null, condition: null, hint_i18n_key: null, kv_block: 'K4' },
        { key: 'end_date', type: 'date', required: true, default: null, choices: null, min_value: null, max_value: null, condition: { field: 'term_type', in: ['date_range'] }, hint_i18n_key: null, kv_block: 'K4' },
      ],
    },
    {
      key: 'payment',
      title_i18n_key: 'contract_forms.rent_items.section.payment',
      external_entity: null,
      fields: [
        { key: 'rent_amount', type: 'decimal', required: true, default: null, choices: null, min_value: '0', max_value: null, condition: null, hint_i18n_key: null, kv_block: 'K3' },
        { key: 'rent_period', type: 'choice', required: true, default: null, choices: ['day', 'week', 'month'], min_value: null, max_value: null, condition: null, hint_i18n_key: null, kv_block: 'K3' },
      ],
    },
  ],
};

const DRAFT = {
  id: DRAFT_ID,
  contract_type_code: 'rent_items',
  deal_type: 'c2c',
  segment: 'free_c2c',
  negotiation_status: 'draft',
  execution_status: null,
  payment_method: null,
  protected: false,
  uses_platform_template: true,
  jurisdiction: 'RU',
  title: '',
  form_data: {},
  warnings: [],
  language: 'ru',
  parties: [],
  total: null,
  initiator_role: 'customer',
  frozen_version_id: null,
  created_at: '2026-08-23T09:00:00Z',
};

const FILLED_VALUES = {
  item_name: 'Перфоратор',
  item_identification: 'Bosch GBH 2-26, серийный 123',
  term_type: 'daily',
  start_date: '2026-09-01',
  rent_amount: '500',
  rent_period: 'day',
};

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/contracts/new/details']}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="details" element={<DetailsStepPage />} />
              <Route path="preview" element={<div data-testid="preview-step" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Шаг «Суть» — аренда', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useContractNewStore.getState().reset();
    localStorage.removeItem(CONTRACT_NEW_STORAGE_KEY);
    const store = useContractNewStore.getState();
    store.setDraftId(DRAFT_ID);
    store.setClientOption('rent');
    store.setContractTypeCode('rent_items');
    server.use(
      http.get(`/v1/contracts/${DRAFT_ID}`, () => HttpResponse.json(DRAFT)),
      http.get(`/v1/contracts/${DRAFT_ID}/milestones`, () => HttpResponse.json([])),
      http.get('/v1/contract-types/rent_items/form-schema', () => HttpResponse.json(RENT_SCHEMA)),
    );
  });

  it('пустая форма: «Далее» заблокировано И подсказка перечисляет незаполненное', async () => {
    renderPage();
    const hint = await screen.findByTestId('details-missing');
    expect(hint.textContent).toContain('Осталось заполнить');
    expect(hint.textContent).toContain('Способ оплаты');
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
  });

  it('всё заполнено (снимок автосейва) — подсказки нет, «Далее» активно', async () => {
    useContractNewStore.getState().setDetails({
      draftId: DRAFT_ID,
      title: 'Аренда перфоратора',
      paymentMethod: 'cash',
      paymentOrder: 'after_acceptance',
      essence: {},
      sale: {},
      schemaValues: FILLED_VALUES,
    });
    renderPage();
    expect(await screen.findByTestId('sf-item_name')).toHaveValue('Перфоратор');
    expect(screen.queryByTestId('details-missing')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
  });

  it('ввод автосейвится в draftStore на каждое поле', async () => {
    renderPage();
    const field = await screen.findByTestId('sf-item_name');
    await userEvent.type(field, 'Дрель');
    const saved = useContractNewStore.getState().details;
    expect(saved?.draftId).toBe(DRAFT_ID);
    expect((saved?.schemaValues as Record<string, unknown>).item_name).toBe('Дрель');
  });
});
