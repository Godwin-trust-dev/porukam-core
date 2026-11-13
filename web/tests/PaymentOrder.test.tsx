import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { DetailsStepPage } from '../src/pages/contract-new/DetailsStepPage';
import { TermsStepPage } from '../src/pages/contract-new/TermsStepPage';
import { PreviewStepPage } from '../src/pages/contract-new/PreviewStepPage';
import {
  CONTRACT_NEW_STORAGE_KEY,
  useContractNewStore,
} from '../src/features/contractNew/draftStore';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';
import { createContract, createMilestone, patchContract } from '../src/mocks/realContractsDb';

/**
 * Первые тесты каждого блока платят за холодный старт страниц (transform +
 * i18n) — на нагруженной машине не укладываются в 5 с по умолчанию, поэтому у
 * них явный таймаут.
 *
 * ADR-151: «Порядок оплаты» (предоплата до начала этапа / постоплата после
 * приёмки) — отдельная ось от способа оплаты, обязателен перед «Далее» там,
 * где применим (услуга/продажа/аренда), не спрашивается у займа, персистится
 * в снимке автосейва шага «Суть», показывается в предпросмотре.
 */

const DRAFT_ID = 'rc-po-test';

function draftOf(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    contract_type_code: 'services_individual',
    deal_type: 'c2c',
    segment: 'free_c2c',
    negotiation_status: 'draft',
    execution_status: null,
    payment_method: 'cash',
    payment_order: null,
    protected: false,
    uses_platform_template: true,
    jurisdiction: 'RU',
    title: '',
    form_data: {},
    additional_terms: [],
    warnings: [],
    language: 'ru',
    parties: [],
    total: null,
    initiator_role: 'customer',
    frozen_version_id: null,
    created_at: '2026-09-03T09:00:00Z',
    ...overrides,
  };
}

// Срез схемы с одним обязательным полем — для аренды и (с другим кодом) займа:
// проверяется только присутствие/отсутствие селекта порядка оплаты.
function schemaOf(code: string): Record<string, unknown> {
  return {
    code,
    schema_version: 1,
    sections: [
      {
        key: 'item',
        title_i18n_key: `contract_forms.${code}.section.item`,
        external_entity: null,
        fields: [
          { key: 'item_name', type: 'string', required: true, default: null, choices: null, min_value: null, max_value: null, condition: null, hint_i18n_key: null, kv_block: 'V' },
        ],
      },
    ],
  };
}

function renderStep(path: 'details' | 'terms' | 'preview'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[`/contracts/new/${path}`]}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="details" element={<DetailsStepPage />} />
              <Route path="terms" element={<TermsStepPage />} />
              <Route path="preview" element={path === 'preview' ? <PreviewStepPage /> : <div data-testid="preview-step-stub" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  useContractNewStore.getState().reset();
  localStorage.removeItem(CONTRACT_NEW_STORAGE_KEY);
});

describe('Порядок оплаты — шаг «Условия» (услуга)', () => {
  it('без порядка оплаты «Далее» заблокировано; выбор уходит в PATCH payment_order', async () => {
    const store = useContractNewStore.getState();
    store.setDraftId(DRAFT_ID);
    store.setClientOption('service');
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get(`/v1/contracts/${DRAFT_ID}`, () => HttpResponse.json(draftOf({}))),
      http.patch(`/v1/contracts/${DRAFT_ID}`, async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(draftOf({ payment_order: patched.payment_order ?? null }));
      }),
    );
    renderStep('terms');
    const select = await screen.findByTestId('payment-order-select');
    // Способ оплаты уже есть (cash) — блокирует именно порядок оплаты.
    expect(screen.getByTestId('wizard-next')).toBeDisabled();

    await userEvent.selectOptions(select, 'before_start');
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await waitFor(() => expect(screen.getByTestId('preview-step-stub')).toBeInTheDocument());
    expect(patched).not.toBeNull();
    expect(patched!.payment_order).toBe('before_start');
    expect(patched!.payment_method).toBe('cash');
  }, 20000);

  it('оба значения подписаны по-русски, без сырых ключей', async () => {
    useContractNewStore.getState().setDraftId(DRAFT_ID);
    useContractNewStore.getState().setClientOption('service');
    server.use(http.get(`/v1/contracts/${DRAFT_ID}`, () => HttpResponse.json(draftOf({}))));
    renderStep('terms');
    const select = (await screen.findByTestId('payment-order-select')) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('Предоплата — до начала этапа');
    expect(labels).toContain('Постоплата — после приёмки этапа');
    for (const l of labels) expect(l).not.toMatch(/contractNew\./);
  });
});

describe('Порядок оплаты — шаг «Суть» (аренда / заём)', () => {
  it('аренда: подсказка «Осталось заполнить» перечисляет порядок оплаты, «Далее» заблокировано', async () => {
    const store = useContractNewStore.getState();
    store.setDraftId(DRAFT_ID);
    store.setClientOption('rent');
    store.setContractTypeCode('rent_items');
    server.use(
      http.get(`/v1/contracts/${DRAFT_ID}`, () => HttpResponse.json(draftOf({ contract_type_code: 'rent_items' }))),
      http.get(`/v1/contracts/${DRAFT_ID}/milestones`, () => HttpResponse.json([])),
      http.get('/v1/contract-types/rent_items/form-schema', () => HttpResponse.json(schemaOf('rent_items'))),
    );
    store.setDetails({
      draftId: DRAFT_ID,
      title: 'Аренда',
      paymentMethod: 'cash',
      paymentOrder: '',
      essence: {},
      sale: {},
      schemaValues: { item_name: 'Перфоратор' },
    });
    renderStep('details');
    const hint = await screen.findByTestId('details-missing');
    expect(hint.textContent).toContain('Порядок оплаты');
    expect(hint.textContent).not.toContain('Способ оплаты');
    expect(screen.getByTestId('wizard-next')).toBeDisabled();

    await userEvent.selectOptions(screen.getByTestId('sf-payment-order'), 'after_acceptance');
    expect(screen.queryByTestId('details-missing')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    // Автосейв: выбор ушёл в снимок шага (persist).
    expect(useContractNewStore.getState().details?.paymentOrder).toBe('after_acceptance');
    expect(localStorage.getItem(CONTRACT_NEW_STORAGE_KEY)).toContain('after_acceptance');
  });

  it('заём: селекта порядка оплаты нет, «Далее» его не требует', async () => {
    const store = useContractNewStore.getState();
    store.setDraftId(DRAFT_ID);
    store.setClientOption('loan');
    store.setContractTypeCode('loan_individuals');
    server.use(
      http.get(`/v1/contracts/${DRAFT_ID}`, () => HttpResponse.json(draftOf({ contract_type_code: 'loan_individuals' }))),
      http.get(`/v1/contracts/${DRAFT_ID}/milestones`, () => HttpResponse.json([])),
      http.get('/v1/contract-types/loan_individuals/form-schema', () => HttpResponse.json(schemaOf('loan_individuals'))),
    );
    store.setDetails({
      draftId: DRAFT_ID,
      title: 'Заём',
      paymentMethod: 'cash',
      paymentOrder: '',
      essence: {},
      sale: {},
      schemaValues: { item_name: 'x' },
    });
    renderStep('details');
    expect(await screen.findByTestId('sf-payment-method')).toBeInTheDocument();
    expect(screen.queryByTestId('sf-payment-order')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-missing')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
  });

  it('снимок автосейва без paymentOrder (записан до появления поля) читается как пусто', async () => {
    const store = useContractNewStore.getState();
    store.setDraftId(DRAFT_ID);
    store.setClientOption('rent');
    store.setContractTypeCode('rent_items');
    server.use(
      http.get(`/v1/contracts/${DRAFT_ID}`, () => HttpResponse.json(draftOf({ contract_type_code: 'rent_items' }))),
      http.get(`/v1/contracts/${DRAFT_ID}/milestones`, () => HttpResponse.json([])),
      http.get('/v1/contract-types/rent_items/form-schema', () => HttpResponse.json(schemaOf('rent_items'))),
    );
    // Старый снимок: поля paymentOrder ещё нет.
    store.setDetails({
      draftId: DRAFT_ID,
      title: 'Аренда',
      paymentMethod: 'cash',
      essence: {},
      sale: {},
      schemaValues: { item_name: 'Перфоратор' },
    } as never);
    renderStep('details');
    expect(await screen.findByTestId('sf-payment-order')).toHaveValue('');
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
  });
});

describe('Порядок оплаты — предпросмотр', () => {
  beforeEach(() => {
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  function seedServiceDraft(paymentOrder: 'before_start' | null): string {
    const contract = createContract({
      client_option: 'service',
      my_role: 'customer',
      my_acting_as: 'person',
      payment_method: 'cash',
      title: 'Ремонт крана',
    });
    patchContract(contract.id, {
      form_data: { work_description: 'Заменить смеситель' },
      ...(paymentOrder ? { payment_order: paymentOrder } : {}),
    });
    createMilestone(contract.id, { title: 'Работа', amount: '1000', currency: 'RUB' });
    useContractNewStore.getState().setDraftId(contract.id);
    useContractNewStore.getState().setClientOption('service');
    return contract.id;
  }

  it('без порядка оплаты — пункт в списке проблем, отправка заблокирована', async () => {
    seedServiceDraft(null);
    renderStep('preview');
    expect(await screen.findByText('Не выбран порядок оплаты — выберите его рядом со способом оплаты.')).toBeInTheDocument();
    expect(screen.getByTestId('send-for-review')).toBeDisabled();
  }, 20000);

  it('с порядком оплаты — строка условий «Порядок оплаты», отправка разблокирована', async () => {
    seedServiceDraft('before_start');
    renderStep('preview');
    expect(await screen.findByText('Предоплата — до начала этапа')).toBeInTheDocument();
    expect(screen.getByText('Порядок оплаты')).toBeInTheDocument();
    expect(screen.queryByText('Не выбран порядок оплаты — выберите его рядом со способом оплаты.')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-for-review')).not.toBeDisabled();
  }, 20000);
});
