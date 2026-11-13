import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { TermsStepPage } from '../src/pages/contract-new/TermsStepPage';
import {
  ADDITIONAL_TERMS_MAX_ITEMS,
  ADDITIONAL_TERM_MAX_LENGTH,
  cleanAdditionalTerms,
} from '../src/features/contractNew/additionalTerms';
import {
  CONTRACT_NEW_STORAGE_KEY,
  useContractNewStore,
} from '../src/features/contractNew/draftStore';
import { useAuthStore } from '../src/features/auth/authStore';
import { server } from '../src/mocks/server';

/**
 * ADR-167 — «Дополнительные условия» в мастере: единственное свободное
 * текстовое поле договора. Блок стоит на шаге «Условия» (шаг перед итогом у
 * услуги), список уходит PATCH'ем черновика целиком.
 */

const DRAFT_ID = 'rc-addterms-test';

const DRAFT = {
  id: DRAFT_ID,
  contract_type_code: 'service_c2c',
  deal_type: 'c2c',
  segment: 'free_c2c',
  negotiation_status: 'draft',
  execution_status: null,
  payment_method: null,
  payment_order: null,
  protected: false,
  uses_platform_template: true,
  jurisdiction: 'RU',
  title: 'Ремонт крана',
  form_data: {},
  additional_terms: [] as string[],
  warnings: [],
  language: 'ru',
  parties: [],
  total: null,
  initiator_role: 'customer',
  frozen_version_id: null,
  created_at: '2026-09-05T09:00:00Z',
};

function renderStep(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/contracts/new/terms']}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="terms" element={<TermsStepPage />} />
              <Route path="preview" element={<div data-testid="preview-step" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function seedServer(draft: typeof DRAFT = DRAFT, onPatch?: (body: unknown) => void): void {
  server.use(
    http.get(`/v1/contracts/${DRAFT_ID}`, () => HttpResponse.json(draft)),
    http.patch(`/v1/contracts/${DRAFT_ID}`, async ({ request }) => {
      const body = await request.json();
      onPatch?.(body);
      return HttpResponse.json({ ...draft, ...(body as object) });
    }),
  );
}

describe('ADR-167: «Дополнительные условия» на шаге «Условия»', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useContractNewStore.getState().reset();
    localStorage.removeItem(CONTRACT_NEW_STORAGE_KEY);
    const store = useContractNewStore.getState();
    store.setDraftId(DRAFT_ID);
    store.setClientOption('service');
  });

  it('блок пуст: ни одного поля, только кнопка «Добавить условие»', async () => {
    seedServer();
    renderStep();
    await screen.findByTestId('additional-terms');
    expect(screen.queryByTestId('additional-term-0')).toBeNull();
    expect(screen.getByTestId('additional-term-add')).toBeEnabled();
  });

  it('«Добавить условие» даёт поле, ввод и удаление работают', async () => {
    const user = userEvent.setup();
    seedServer();
    renderStep();
    await user.click(await screen.findByTestId('additional-term-add'));
    const field = screen.getByTestId('additional-term-0');
    await user.type(field, 'Ключи под расписку');
    expect(field).toHaveValue('Ключи под расписку');

    await user.click(screen.getByTestId('additional-term-remove-0'));
    expect(screen.queryByTestId('additional-term-0')).toBeNull();
  });

  it('счётчик показывает длину пункта и предел', async () => {
    const user = userEvent.setup();
    seedServer();
    renderStep();
    await user.click(await screen.findByTestId('additional-term-add'));
    await user.type(screen.getByTestId('additional-term-0'), 'Ключи');
    expect(screen.getByTestId('additional-term-counter-0')).toHaveTextContent(
      `5 / ${ADDITIONAL_TERM_MAX_LENGTH}`,
    );
  });

  it('поле не даёт ввести больше предела длины (maxLength textarea)', async () => {
    const user = userEvent.setup();
    seedServer();
    renderStep();
    await user.click(await screen.findByTestId('additional-term-add'));
    expect(screen.getByTestId('additional-term-0')).toHaveAttribute(
      'maxlength',
      String(ADDITIONAL_TERM_MAX_LENGTH),
    );
  });

  it('на пределе числа пунктов «Добавить» блокируется и появляется подсказка', async () => {
    seedServer({
      ...DRAFT,
      additional_terms: Array.from({ length: ADDITIONAL_TERMS_MAX_ITEMS }, (_, i) => `Условие ${i}`),
    });
    renderStep();
    await waitFor(() => expect(screen.getByTestId('additional-term-add')).toBeDisabled());
    expect(screen.getByTestId('additional-terms-limit')).toBeInTheDocument();
  });

  it('«Далее» шлёт PATCH с additional_terms; пустые пункты отбрасываются', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    seedServer(DRAFT, onPatch);
    renderStep();
    await user.click(await screen.findByTestId('additional-term-add'));
    await user.type(screen.getByTestId('additional-term-0'), '  Ключи под расписку  ');
    // Второй пункт остаётся пустым — конструктор его держит, сервер не увидит.
    await user.click(screen.getByTestId('additional-term-add'));

    await user.selectOptions(screen.getByTestId('payment-method-select'), 'cash');
    await user.selectOptions(screen.getByTestId('payment-order-select'), 'after_acceptance');
    await user.click(screen.getByTestId('wizard-next'));

    await screen.findByTestId('preview-step');
    expect(onPatch).toHaveBeenCalled();
    const body = onPatch.mock.calls[0]![0] as { additional_terms?: string[] };
    expect(body.additional_terms).toEqual(['Ключи под расписку']);
  });

  it('существующие условия договора подставляются в конструктор', async () => {
    seedServer({ ...DRAFT, additional_terms: ['Уборка после работ'] });
    renderStep();
    await waitFor(() =>
      expect(screen.getByTestId('additional-term-0')).toHaveValue('Уборка после работ'),
    );
  });

  it('снимок автосейва главнее серверного списка при возврате на шаг', async () => {
    useContractNewStore.getState().setTerms({
      draftId: DRAFT_ID,
      terms: { warrantyPeriodDays: '14', acceptanceWindowHours: '72', subcontractPolicy: 'forbidden', accessRequired: false, portfolioVisible: true },
      paymentMethod: 'cash',
      paymentOrder: 'after_acceptance',
      additionalTerms: ['Ещё не отправленное условие'],
    });
    seedServer({ ...DRAFT, additional_terms: ['Старое серверное'] });
    renderStep();
    await waitFor(() =>
      expect(screen.getByTestId('additional-term-0')).toHaveValue('Ещё не отправленное условие'),
    );
  });
});

describe('cleanAdditionalTerms', () => {
  it('обрезает пробелы и выбрасывает пустые пункты', () => {
    expect(cleanAdditionalTerms([' Первое ', '', '   ', 'Второе'])).toEqual(['Первое', 'Второе']);
  });

  it('пустой список остаётся пустым (очистка всех условий)', () => {
    expect(cleanAdditionalTerms(['   '])).toEqual([]);
  });
});
