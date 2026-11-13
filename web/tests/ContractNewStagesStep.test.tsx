import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { StagesStepPage } from '../src/pages/contract-new/StagesStepPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useContractNewStore } from '../src/features/contractNew/draftStore';
import { createChecklistItem, createContract, createMilestone, listChecklistItems } from '../src/mocks/realContractsDb';
import { server } from '../src/mocks/server';

/**
 * Отсмотр 2026-08-25 («создаю договор аренды: после создания одного критерия
 * другие уже не пропускает, не сохраняет»): у УЖЕ созданного на сервере этапа
 * редактор чек-листа прятался, а «Далее» отправлял пункты только новых
 * этапов. Теперь критерии редактируются всегда, по «Далее» список сверяется
 * с серверным (POST новых / DELETE убранных), число пунктов не ограничено.
 */

function renderStep(): RenderResult {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={createI18n('ru')}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/contracts/new/stages']}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="stages" element={<StagesStepPage />} />
              <Route path="terms" element={<div data-testid="terms-step" />} />
              <Route path="details" element={<div data-testid="details-step" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

/** Черновик с одним уже сохранённым этапом и заданными критериями — как после
 * первого «Далее» на этом шаге (или при возврате на него). */
function seedDraftWithSavedStage(texts: string[] = ['Плитка уложена без пустот']): { milestoneId: string; itemIds: string[] } {
  const contract = createContract({ client_option: 'service', my_role: 'customer', my_acting_as: 'person', payment_method: 'cash' });
  const milestone = createMilestone(contract.id, { title: 'Укладка плитки', amount: '1000', currency: 'RUB' });
  const itemIds = texts.map(
    (text, order) =>
      createChecklistItem(milestone.id, {
        description: text,
        measurable_criterion: text,
        required_evidence: ['photo'],
        order,
      }).id,
  );
  useContractNewStore.getState().setDraftId(contract.id);
  return { milestoneId: milestone.id, itemIds };
}

/** Журнал запросов к чек-листам — тест проверяет ИМЕННО метод/путь
 * (POST нового пункта, PATCH изменённого, DELETE убранного). */
const checklistCalls: string[] = [];
function checklistCallsMatching(re: RegExp): string[] {
  return checklistCalls.filter((c) => re.test(c));
}

async function openSavedStage(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByTestId('stage-open'));
  await screen.findByTestId('stage-editor');
}

describe('Мастер, шаг «Этапы» — чек-лист сохранённого этапа', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useContractNewStore.getState().reset();
    checklistCalls.length = 0;
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path.includes('checklist-items')) checklistCalls.push(`${request.method} ${path}`);
    });
  });

  afterEach(() => server.events.removeAllListeners());

  it('у этапа с серверным id редактор чек-листа виден вместе с уже сохранённым пунктом', async () => {
    const user = userEvent.setup();
    const {
      itemIds: [itemId],
    } = seedDraftWithSavedStage();
    renderStep();
    await openSavedStage(user);
    expect(screen.getByTestId('checklist-editor')).toBeInTheDocument();
    expect(screen.getByText('Плитка уложена без пустот')).toBeInTheDocument();
    expect(screen.getByTestId(`checklist-remove-srv-${itemId}`)).toBeInTheDocument();
    expect(screen.getByTestId('checklist-add-input')).toBeInTheDocument();
  });

  it('второй и третий критерии добавляются и по «Далее» уходят POST-ом (лимита нет)', async () => {
    const user = userEvent.setup();
    const {
      milestoneId,
      itemIds: [itemId],
    } = seedDraftWithSavedStage();
    renderStep();
    await openSavedStage(user);
    await user.type(screen.getByTestId('checklist-add-input'), 'Швы затёрты равномерно{enter}');
    await user.type(screen.getByTestId('checklist-add-input'), 'Нет сколов на кромках{enter}');
    expect(screen.getByText('Швы затёрты равномерно')).toBeInTheDocument();
    expect(screen.getByText('Нет сколов на кромках')).toBeInTheDocument();
    await user.click(screen.getByTestId('stage-save'));

    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    const items = listChecklistItems(milestoneId);
    expect(items.map((it) => it.description)).toEqual(['Плитка уложена без пустот', 'Швы затёрты равномерно', 'Нет сколов на кромках']);
    expect(items[0]!.id).toBe(itemId); // существующий пункт не пересоздан
    expect(items.slice(1).map((it) => it.order)).toEqual([1, 2]);
    // Новый пункт уходит БЕЗ требования доказательства (решение владельца
    // 05.09; ADR-164 — рекомендация, не гейт): раньше мастер ставил ['photo']
    // каждому. Включение требования проверяет тест ниже.
    expect(items[1]!.required_evidence).toEqual([]);
    // два новых пункта — ровно два POST, существующий не трогали
    expect(checklistCallsMatching(/^POST/)).toEqual([`POST /v1/milestones/${milestoneId}/checklist-items`, `POST /v1/milestones/${milestoneId}/checklist-items`]);
    expect(checklistCallsMatching(/^(PATCH|DELETE)/)).toEqual([]);
  });

  it('переключатель «нужно доказательство» на новом пункте уходит POST-ом с photo', async () => {
    const user = userEvent.setup();
    const { milestoneId } = seedDraftWithSavedStage();
    renderStep();
    await openSavedStage(user);
    await user.type(screen.getByTestId('checklist-add-input'), 'Швы затёрты равномерно{enter}');

    // Пункт создан без требования — переключатель снят; включаем вручную.
    const toggles = screen.getAllByTestId(/^checklist-evidence-/);
    const added = toggles[toggles.length - 1]!;
    expect(added).not.toBeChecked();
    await user.click(added);
    await user.click(screen.getByTestId('stage-save'));

    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    const items = listChecklistItems(milestoneId);
    expect(items[1]!.description).toBe('Швы затёрты равномерно');
    expect(items[1]!.required_evidence).toEqual(['photo']);
  });

  it('снятый переключатель у серверного пункта уходит PATCH-ем с пустым required_evidence', async () => {
    const user = userEvent.setup();
    const { milestoneId, itemIds } = seedDraftWithSavedStage();
    renderStep();
    await openSavedStage(user);

    // Серверный пункт засеян с ['photo'] — переключатель отмечен; снимаем.
    const toggle = screen.getByTestId(`checklist-evidence-srv-${itemIds[0]!}`);
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByTestId('stage-save'));

    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    expect(listChecklistItems(milestoneId)[0]!.required_evidence).toEqual([]);
    expect(checklistCallsMatching(/^PATCH/)).toEqual([`PATCH /v1/checklist-items/${itemIds[0]!}`]);
  });

  it('удалённый в конструкторе серверный пункт по «Далее» уходит DELETE-ом', async () => {
    const user = userEvent.setup();
    const {
      milestoneId,
      itemIds: [itemId],
    } = seedDraftWithSavedStage();
    renderStep();
    await openSavedStage(user);
    await user.click(screen.getByTestId(`checklist-remove-srv-${itemId}`));
    expect(screen.queryByText('Плитка уложена без пустот')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('stage-save'));

    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');
    await waitFor(() => expect(listChecklistItems(milestoneId)).toEqual([]));
    expect(checklistCallsMatching(/^DELETE/)).toEqual([`DELETE /v1/checklist-items/${itemId}`]);
    expect(checklistCallsMatching(/^POST/)).toEqual([]);
  });

  it('после удаления первого из двух пунктов второй перенумеровывается PATCH-ом (order)', async () => {
    const user = userEvent.setup();
    const {
      milestoneId,
      itemIds: [firstId, secondId],
    } = seedDraftWithSavedStage(['Плитка уложена без пустот', 'Швы затёрты равномерно']);
    renderStep();
    await openSavedStage(user);
    await user.click(screen.getByTestId(`checklist-remove-srv-${firstId}`));
    await user.click(screen.getByTestId('stage-save'));

    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('terms-step');

    await waitFor(() => expect(listChecklistItems(milestoneId).map((it) => it.description)).toEqual(['Швы затёрты равномерно']));
    expect(listChecklistItems(milestoneId)[0]!.order).toBe(0); // перенумерация после удаления
    expect(checklistCallsMatching(/^DELETE/)).toEqual([`DELETE /v1/checklist-items/${firstId}`]);
    expect(checklistCallsMatching(/^PATCH/)).toEqual([`PATCH /v1/checklist-items/${secondId}`]);
  });

  /** Дословная репродукция отсмотра 2026-08-25: критерии добавляются по одному,
   * между ними шаг сохраняется и открывается заново — раньше со второго
   * захода редактор был скрыт и пункт «не проходил». */
  it('три критерия подряд, каждый через своё «Далее» и возврат на шаг, — все сохраняются', async () => {
    const { milestoneId } = seedDraftWithSavedStage([]);
    const texts = ['Плитка уложена без пустот', 'Швы затёрты равномерно', 'Нет сколов на кромках'];
    for (const [i, text] of texts.entries()) {
      const user = userEvent.setup();
      const { unmount } = renderStep();
      await openSavedStage(user);
      expect(screen.getByTestId('checklist-editor')).toBeInTheDocument();
      await user.type(screen.getByTestId('checklist-add-input'), `${text}{enter}`);
      await user.click(screen.getByTestId('stage-save'));
      await user.click(screen.getByTestId('wizard-next'));
      await screen.findByTestId('terms-step');
      await waitFor(() => expect(listChecklistItems(milestoneId)).toHaveLength(i + 1));
      unmount();
    }
    const items = listChecklistItems(milestoneId);
    expect(items.map((it) => it.description)).toEqual(texts);
    expect(items.map((it) => it.order)).toEqual([0, 1, 2]);
    expect(new Set(items.map((it) => it.id)).size).toBe(3); // пункты не пересозданы/не задублированы
    expect(checklistCallsMatching(/^POST/)).toHaveLength(3);
  });
});
