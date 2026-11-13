import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pickSearchOption, searchAndPick } from './pickSearchOption';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { StagesStepPage } from '../src/pages/contract-new/StagesStepPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useContractNewStore } from '../src/features/contractNew/draftStore';
import { createContract, createMaterial, createMilestone, listMaterials } from '../src/mocks/realContractsDb';
import { server } from '../src/mocks/server';

/**
 * Решение владельца 03.09: «верни в мастер на шаг Этапы. она [кнопка
 * «Материалы»] не должна исчезать». Материалы были скрыты features-флагом с
 * 18.08 (окно не было подключено к реальному API). Теперь окно заводит
 * позиции каталога/«Прочее», а по «Далее» список сверяется с серверным —
 * новые POST, убранные DELETE, изменённые PATCH (тот же приём, что чек-лист).
 */

function renderWizard(initialPath = '/contracts/new/stages'): RenderResult {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={createI18n('ru')}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="stages" element={<StagesStepPage />} />
              <Route path="terms" element={<div data-testid="terms-step" />} />
              <Route path="details" element={<div data-testid="details-step" />} />
            </Route>
          </Routes>
          <nav>
            <Link to="/contracts/new/details" data-testid="go-details">details</Link>
            <Link to="/contracts/new/stages" data-testid="go-stages">stages</Link>
          </nav>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function seedDraft(): string {
  const contract = createContract({ client_option: 'service', my_role: 'customer', my_acting_as: 'person' });
  const store = useContractNewStore.getState();
  store.setDraftId(contract.id);
  store.setClientOption('service');
  store.setSphere('Ремонт', 'repair');
  store.setCurrency('RUB');
  return contract.id;
}

/** Журнал запросов к материалам — тест проверяет ИМЕННО метод/путь. */
const materialCalls: string[] = [];

async function openMaterials(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByTestId('stage-open'));
  await screen.findByTestId('stage-editor');
  await user.click(screen.getByTestId('open-materials'));
  await screen.findByTestId('material-add');
}

describe('Мастер, шаг «Этапы» — материалы', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useContractNewStore.getState().reset();
    materialCalls.length = 0;
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path.includes('/materials')) materialCalls.push(`${request.method} ${path}`);
    });
  });

  afterEach(() => server.events.removeAllListeners());

  it('кнопка «Материалы» на этапе открывает окно и позиция каталога уходит POST-ом по «Далее»', async () => {
    const user = userEvent.setup();
    seedDraft();
    renderWizard();
    await user.click(await screen.findByTestId('add-stage'));
    await openMaterials(user);

    await pickSearchOption(user, 'material-catalog-select', 'Плитка керамическая');
    await user.type(screen.getByLabelText('Количество'), '12');
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'customer');
    await user.type(screen.getByTestId('material-price'), '1200');
    await user.type(screen.getByTestId('material-delivery-days'), '3');
    await user.click(screen.getByTestId('material-add'));
    expect(screen.getByTestId('materials-list')).toHaveTextContent('Плитка керамическая');

    await user.click(screen.getByTestId('materials-done'));
    await user.click(screen.getByTestId('stage-save'));
    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    const milestoneId = materialCalls
      .find((c) => c.startsWith('POST'))!
      .replace('POST /v1/milestones/', '')
      .replace('/materials', '');
    const [material] = listMaterials(milestoneId);
    expect(material).toMatchObject({
      catalog_item_code: 'cat-tile',
      description: 'Плитка керамическая',
      quantity: '12',
      unit_price: '1200.00',
      unit_price_currency: 'RUB',
      source: 'customer',
      delivery_days: 3,
      delivery_base: 'contract_signing',
    });
  }, 20_000);

  it('тип из каталога + название материала: description = «тип — уточнение», поле видно всегда', async () => {
    const user = userEvent.setup();
    seedDraft();
    renderWizard();
    await user.click(await screen.findByTestId('add-stage'));
    await openMaterials(user);

    // Владелец 03.09: поле «Название материала» доступно ВСЕГДА, а не только
    // при «Прочем» — туда вписывают производителя, цвет, артикул.
    expect(screen.getByTestId('material-custom-name')).toBeInTheDocument();
    // Подпись каталога — «Тип материала» (классификатор), не «Наименование».
    expect(screen.getByLabelText('Тип материала')).toBeInTheDocument();
    // Пояснения к срокам — обычным hint под полем, без значка «?».
    expect(screen.getByText(/Сколько дней идёт поставка/)).toBeInTheDocument();

    await pickSearchOption(user, 'material-catalog-select', 'Плитка керамическая');
    await user.type(screen.getByTestId('material-custom-name'), 'Kerama Marazzi, белая');
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'customer');
    await user.click(screen.getByTestId('material-add'));
    expect(screen.getByTestId('materials-list')).toHaveTextContent('Плитка керамическая — Kerama Marazzi, белая');

    // Правка позиции не удваивает название типа: уточнение вынимается обратно.
    await user.click(screen.getAllByLabelText('Изменить материал')[0]!);
    expect(screen.getByTestId('material-custom-name')).toHaveValue('Kerama Marazzi, белая');
    await user.click(screen.getByTestId('material-add'));
    expect(screen.getByTestId('materials-list')).toHaveTextContent('Плитка керамическая — Kerama Marazzi, белая');
    expect(screen.getByTestId('materials-list')).not.toHaveTextContent('Плитка керамическая — Плитка керамическая');
  }, 20_000);

  it('«Прочее» со своим названием: цена материала исполнителя обязательна', async () => {
    const user = userEvent.setup();
    seedDraft();
    renderWizard();
    await user.click(await screen.findByTestId('add-stage'));
    await openMaterials(user);

    await pickSearchOption(user, 'material-catalog-select', 'Прочее');
    await user.type(screen.getByLabelText(/Название материала/), 'Уголок алюминиевый');
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'contractor');
    // Цена не заполнена — ADR-047: материал исполнителя не бывает бесплатным.
    await user.click(screen.getByTestId('material-add'));
    expect(screen.getByTestId('material-error')).toBeInTheDocument();
    expect(screen.queryByTestId('materials-list')).not.toBeInTheDocument();

    await user.type(screen.getByTestId('material-price'), '450');
    await user.click(screen.getByTestId('material-add'));
    expect(screen.getByTestId('materials-list')).toHaveTextContent('Уголок алюминиевый');

    await user.click(screen.getByTestId('materials-done'));
    await user.click(screen.getByTestId('stage-save'));
    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    const milestoneId = materialCalls
      .find((c) => c.startsWith('POST'))!
      .replace('POST /v1/milestones/', '')
      .replace('/materials', '');
    expect(listMaterials(milestoneId)[0]).toMatchObject({
      catalog_item_code: 'other',
      description: 'Уголок алюминиевый',
      source: 'contractor',
      unit_price: '450.00',
    });
  }, 20_000);

  it('материал уже сохранённого этапа: убранный из списка уходит DELETE-ом по «Далее»', async () => {
    const user = userEvent.setup();
    const draftId = seedDraft();
    const milestone = createMilestone(draftId, { title: 'Укладка плитки', amount: '1000', currency: 'RUB' });
    const material = createMaterial(milestone.id, {
      catalog_item_code: 'cat-tile',
      description: 'Плитка керамическая',
      source: 'customer',
      unit_price: '1200.00',
      unit_price_currency: 'RUB',
    });
    renderWizard();
    await openMaterials(user);

    expect(screen.getByTestId('materials-list')).toHaveTextContent('Плитка керамическая');
    await user.click(screen.getByTestId(`material-remove-srv-${material.id}`));
    await user.click(screen.getByTestId('materials-done'));
    await user.click(screen.getByTestId('stage-save'));
    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    expect(listMaterials(milestone.id)).toEqual([]);
    expect(materialCalls).toContain(`DELETE /v1/materials/${material.id}`);
    expect(materialCalls.filter((c) => c.startsWith('POST'))).toEqual([]);
  }, 20_000);

  it('материал сохранённого этапа правится в окне и уходит PATCH-ом (нового не создаётся)', async () => {
    const user = userEvent.setup();
    const draftId = seedDraft();
    const milestone = createMilestone(draftId, { title: 'Укладка плитки', amount: '1000', currency: 'RUB' });
    const material = createMaterial(milestone.id, {
      catalog_item_code: 'cat-tile',
      description: 'Плитка керамическая',
      source: 'customer',
      unit_price: '1200.00',
      unit_price_currency: 'RUB',
      quantity: '12',
    });
    renderWizard();
    await openMaterials(user);

    await user.click(screen.getByTestId(`material-edit-srv-${material.id}`));
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'contractor');
    await user.click(screen.getByTestId('material-add')); // в режиме правки — «Сохранить материал»
    await user.click(screen.getByTestId('materials-done'));
    await user.click(screen.getByTestId('stage-save'));
    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    const items = listMaterials(milestone.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(material.id); // не пересоздан
    expect(items[0]!.source).toBe('contractor');
    expect(materialCalls).toContain(`PATCH /v1/materials/${material.id}`);
  }, 20_000);

  it('снимок шага помнит материалы при уходе на соседний шаг; чужой черновик игнорируется', async () => {
    const user = userEvent.setup();
    seedDraft();
    const view = renderWizard();
    await user.click(await screen.findByTestId('add-stage'));
    await openMaterials(user);
    await searchAndPick(user, 'material-catalog-select', 'лам', 'Ламинат');
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'customer');
    await user.click(screen.getByTestId('material-add'));
    await user.click(screen.getByTestId('materials-done'));
    await user.click(screen.getByTestId('stage-save'));

    // Уход на соседний шаг и возврат — материал на месте (POST ещё не было).
    await user.click(screen.getByTestId('go-details'));
    await screen.findByTestId('details-step');
    await user.click(screen.getByTestId('go-stages'));
    await openMaterials(user);
    expect(screen.getByTestId('materials-list')).toHaveTextContent('Ламинат');
    expect(materialCalls.filter((c) => c.startsWith('POST'))).toEqual([]);

    // Снимок ЧУЖОГО черновика к этому договору не относится: после «перезагрузки»
    // показывается серверное дерево (пустое — «Далее» ещё не было), а не чужой этап.
    const mine = useContractNewStore.getState().stages!;
    view.unmount();
    useContractNewStore.getState().setStages({ ...mine, draftId: 'rc-someone-else' });
    renderWizard();
    await screen.findByTestId('stages-builder');
    expect(screen.queryByTestId('stage-open')).not.toBeInTheDocument();
  }, 20_000);
});
