import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { PreviewStepPage } from '../src/pages/contract-new/PreviewStepPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useContractNewStore, type ClientOption } from '../src/features/contractNew/draftStore';
import { createContract } from '../src/mocks/realContractsDb';

/**
 * Отсмотр 2026-09-02 («на вкладке Отправить на согласование на мобильном нет
 * кнопки назад, фактически не можешь вернуться к редактированию»): последний
 * шаг мастера рисовал только «Отправить», путь назад был лишь кликом по
 * кружку степпера. Теперь «Назад» — тот же паттерн, что у остальных шагов
 * (WizardFooter, testid `wizard-back`), ведёт на предыдущий шаг адаптивного
 * списка и не сбрасывает черновик.
 */

function renderPage(): RenderResult {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={createI18n('ru')}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/contracts/new/preview']}>
          <Routes>
            <Route path="/contracts/new">
              <Route path="preview" element={<PreviewStepPage />} />
              <Route path="terms" element={<div data-testid="terms-step" />} />
              <Route path="details" element={<div data-testid="details-step" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function seedDraft(clientOption: ClientOption): string {
  const contract = createContract({ client_option: clientOption, my_role: 'customer', my_acting_as: 'person', payment_method: 'cash' });
  useContractNewStore.getState().setDraftId(contract.id);
  useContractNewStore.getState().setClientOption(clientOption);
  return contract.id;
}

/** Первый рендер шага поднимает весь мок-стек (договор, «я», типы,
 * этапы) — на загруженной машине холодный старт выходит за 5 с по умолчанию. */
const STEP_TIMEOUT = 15_000;

describe('Мастер, шаг «Отправить на согласование» — «Назад»', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useContractNewStore.getState().reset();
  });

  it('услуга: «Назад» рядом с отправкой ведёт на «Условия», черновик в сторе остаётся', async () => {
    const draftId = seedDraft('service');
    renderPage();
    const user = userEvent.setup();

    const back = await screen.findByTestId('wizard-back');
    expect(back).toHaveTextContent('Назад');
    expect(screen.getByTestId('send-for-review')).toBeInTheDocument();

    await user.click(back);

    expect(await screen.findByTestId('terms-step')).toBeInTheDocument();
    expect(useContractNewStore.getState().draftId).toBe(draftId);
    expect(useContractNewStore.getState().clientOption).toBe('service');
  }, STEP_TIMEOUT);

  it('продажа (без шагов «Этапы/Условия»): «Назад» ведёт на «Суть»', async () => {
    seedDraft('sale');
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('wizard-back'));

    expect(await screen.findByTestId('details-step')).toBeInTheDocument();
  }, STEP_TIMEOUT);
});
