import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { DetailsStepPage } from '../src/pages/contract-new/DetailsStepPage';
import { StagesStepPage } from '../src/pages/contract-new/StagesStepPage';
import { TermsStepPage } from '../src/pages/contract-new/TermsStepPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { CONTRACT_NEW_STORAGE_KEY, useContractNewStore } from '../src/features/contractNew/draftStore';
import { createContract, createMilestone, getContract } from '../src/mocks/realContractsDb';
import { server } from '../src/mocks/server';

/**
 * Замечание владельца 02.09: «при создании договора услуг нет промежуточного
 * сохранения. если на этапе случайно нажал не ту кнопку — отбрасывает на суть
 * договора, а там много текста уже введено». Два источника потери:
 * 1) шаг «Этапы» держал дерево только в state страницы — «Назад»/степпер/F5
 *    до «Далее» стирали все этапы с чек-листами;
 * 2) после «Далее» на «Сути» кэш договора оставался старым до конца
 *    перезапроса — быстрый возврат на шаг засевал форму ПРЕЖНИМ form_data,
 *    и введённый текст «откатывался» (а «Условия» отправили бы его на сервер).
 * Теперь ввод каждого шага живёт в draftStore (persist) до своего «Далее»,
 * а PATCH договора сразу кладёт ответ в кэш.
 */

function renderWizard(initialPath: string): RenderResult {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={createI18n('ru')}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="details" element={<DetailsStepPage />} />
              <Route path="stages" element={<StagesStepPage />} />
              <Route path="terms" element={<TermsStepPage />} />
              <Route path="preview" element={<div data-testid="preview-step" />} />
            </Route>
          </Routes>
          {/* «Не та кнопка»: ссылки-заглушки вместо соседних шагов — переход и возврат. */}
          <nav>
            <Link to="/contracts/new/details" data-testid="go-details">details</Link>
            <Link to="/contracts/new/stages" data-testid="go-stages">stages</Link>
            <Link to="/contracts/new/terms" data-testid="go-terms">terms</Link>
          </nav>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function seedServiceDraft(): string {
  const contract = createContract({ client_option: 'service', my_role: 'customer', my_acting_as: 'person' });
  const store = useContractNewStore.getState();
  store.setDraftId(contract.id);
  store.setClientOption('service');
  store.setSphere('Ремонт', 'repair');
  return contract.id;
}

describe('Мастер договора — ввод шага переживает случайный уход и возврат', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useContractNewStore.getState().reset();
    localStorage.removeItem(CONTRACT_NEW_STORAGE_KEY);
  });

  afterEach(() => server.resetHandlers());

  it('«Этапы»: этап с суммой и критерием переживает «Назад» на «Суть» и возврат (до «Далее»)', async () => {
    const user = userEvent.setup();
    seedServiceDraft();
    renderWizard('/contracts/new/stages');

    await user.click(await screen.findByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await screen.findByTestId('stage-editor');
    await user.type(screen.getByTestId('stage-amount'), '1500');
    await user.type(screen.getByTestId('checklist-add-input'), 'Без пустот{enter}');
    await user.click(screen.getByTestId('stage-save'));

    // «Не та кнопка» — «Назад» уводит на «Суть»…
    await user.click(screen.getByTestId('wizard-back'));
    await screen.findByTestId('contract-title');
    // …и возврат на «Этапы»: этап на месте вместе с суммой и критерием.
    await user.click(screen.getByTestId('go-stages'));
    await user.click(await screen.findByTestId('stage-open'));
    await screen.findByTestId('stage-editor');
    expect(screen.getByTestId('stage-amount')).toHaveValue('1500');
    expect(screen.getByText('Без пустот')).toBeInTheDocument();
  }, 15_000);

  it('«Этапы»: снимок переживает F5 (localStorage + rehydrate) и подхватывается при монтировании', async () => {
    const user = userEvent.setup();
    seedServiceDraft();
    const first = renderWizard('/contracts/new/stages');
    await user.click(await screen.findByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await user.type(await screen.findByTestId('stage-amount'), '700');
    await user.click(screen.getByTestId('stage-save'));
    first.unmount();

    // «Перезагрузка»: память обнулилась, хранилище — нет (приём ContractNewPersist.test).
    const snapshot = localStorage.getItem(CONTRACT_NEW_STORAGE_KEY) ?? '';
    expect(snapshot).toContain('"700"');
    useContractNewStore.setState({ stages: null });
    localStorage.setItem(CONTRACT_NEW_STORAGE_KEY, snapshot);
    await useContractNewStore.persist.rehydrate();

    renderWizard('/contracts/new/stages');
    await user.click(await screen.findByTestId('stage-open'));
    expect(await screen.findByTestId('stage-amount')).toHaveValue('700');
  }, 15_000);

  it('«Этапы»: снимок ЧУЖОГО черновика игнорируется — показывается серверное дерево', async () => {
    const draftId = seedServiceDraft();
    createMilestone(draftId, { title: 'Серверный этап', amount: '900', currency: 'RUB' });
    useContractNewStore.getState().setStages({
      draftId: 'rc-someone-else',
      totalCost: '5000',
      stages: [
        {
          id: 'stage-foreign',
          sectionId: null,
          title: 'Чужой этап',
          amount: '5000',
          auto: false,
          durationDays: '',
          checklist: [],
          materials: [],
          advance: null,
          advancePercent: null,
        },
      ],
    });
    renderWizard('/contracts/new/stages');
    expect(await screen.findByText('Серверный этап')).toBeInTheDocument();
    expect(screen.queryByText('Чужой этап')).not.toBeInTheDocument();
    expect(screen.getByTestId('total-cost')).toHaveValue('');
  }, 15_000);

  it('«Этапы»: после успешного «Далее» снимок очищается, а «Условия» показывают серверное дерево', async () => {
    const user = userEvent.setup();
    seedServiceDraft();
    renderWizard('/contracts/new/stages');
    await user.click(await screen.findByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await user.type(await screen.findByTestId('stage-amount'), '300');
    await user.click(screen.getByTestId('stage-save'));
    expect(useContractNewStore.getState().stages?.stages).toHaveLength(1);

    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('payment-method-select');
    expect(useContractNewStore.getState().stages).toBeNull();
  }, 15_000);

  it('«Суть»: текст, отправленный по «Далее», не откатывается при быстром возврате с «Этапов» (кэш после PATCH)', async () => {
    const user = userEvent.setup();
    seedServiceDraft();
    renderWizard('/contracts/new/details');
    const description = await screen.findByTestId('work-description');

    // Медленный перезапрос договора — окно, в котором кэш ещё старый.
    server.use(
      http.get('/v1/contracts/:id', async ({ params }) => {
        await delay(3000);
        return HttpResponse.json(getContract(String(params.id)));
      }),
    );

    const text = 'Демонтаж, стяжка, плитка';
    await user.type(description, text);
    await user.type(screen.getByTestId('location-address'), 'Тверская 1');
    fireEvent.change(screen.getByTestId('start-date'), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByTestId('end-date'), { target: { value: '2026-09-20' } });
    await waitFor(() => expect(screen.getByTestId('wizard-next')).not.toBeDisabled());

    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('stages-builder');
    // Сразу «Назад» — раньше форма засевалась старым form_data из кэша.
    await user.click(screen.getByTestId('wizard-back'));
    expect(await screen.findByTestId('work-description')).toHaveValue(text);
    expect(screen.getByTestId('location-address')).toHaveValue('Тверская 1');
  }, 15_000);

  it('«Условия»: гарантия и способ оплаты переживают уход на «Этапы» и возврат (до «Далее»)', async () => {
    const user = userEvent.setup();
    seedServiceDraft();
    renderWizard('/contracts/new/terms');
    const select = await screen.findByTestId('payment-method-select');
    await user.selectOptions(select, 'cash');
    const warranty = screen.getByPlaceholderText('По умолчанию 14');
    await user.clear(warranty);
    await user.type(warranty, '30');

    await user.click(screen.getByTestId('wizard-back'));
    await screen.findByTestId('stages-builder');
    await user.click(screen.getByTestId('go-terms'));
    expect(await screen.findByTestId('payment-method-select')).toHaveValue('cash');
    expect(screen.getByPlaceholderText('По умолчанию 14')).toHaveValue('30');
  }, 15_000);

  it('«Условия»: снимок чужого черновика игнорируется', async () => {
    seedServiceDraft();
    useContractNewStore.getState().setTerms({
      draftId: 'rc-someone-else',
      paymentMethod: 'cash',
      paymentOrder: 'before_start',
      terms: { warrantyPeriodDays: '99', acceptanceWindowHours: '72', subcontractPolicy: 'forbidden', accessRequired: false, portfolioVisible: true },
    });
    renderWizard('/contracts/new/terms');
    expect(await screen.findByTestId('payment-method-select')).toHaveValue('');
    expect(screen.getByPlaceholderText('По умолчанию 14')).toHaveValue('14');
  }, 15_000);
});
