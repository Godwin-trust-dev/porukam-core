import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ReputationInsightsPage } from '../src/pages/ReputationInsightsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/**
 * Приватный разбор своей репутации (ADR-163 §8). Проверяется ровно то,
 * ради чего экран существует: раскрытие цифр в конкретные этапы (с
 * причиной возврата и датой), подсказка «до зелёной зоны осталось N» и
 * блок «считается, но не показывается другим» — единственное место в
 * продукте, где объём и защищённые платежи вообще видны.
 */
const PROFILE_FULL = '018f1a00-0000-7000-8000-0000000000a1';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/me/reputation']}>
          <Routes>
            <Route path="/me/reputation" element={<ReputationInsightsPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('ReputationInsightsPage (ADR-163)', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
    useActorStore.setState({ activeProfileId: PROFILE_FULL });
  });

  it('первым блоком — ссылка на то, что видят другие', async () => {
    renderPage();
    const guest = await screen.findByTestId('insights-guest');
    expect(within(guest).getByText('Так вас видит гость и контрагент.')).toBeInTheDocument();
    expect(within(guest).getByRole('button', { name: 'Открыть' })).toBeInTheDocument();
  });

  it('«за 30 дней»: сделки, контрагенты, возвраты', async () => {
    renderPage();
    const recent = await screen.findByTestId('insights-recent');
    expect(within(recent).getByText('+2 сделок')).toBeInTheDocument();
    expect(within(recent).getByText('+1 контрагентов')).toBeInTheDocument();
    expect(within(recent).getByText('этапов вернули на доработку: 1')).toBeInTheDocument();
  });

  it('метрики названы по РОЛИ — «в срок» без уточнения нигде нет', async () => {
    renderPage();
    const metrics = await screen.findByTestId('insights-metrics');
    expect(within(metrics).getByText('Сделано в срок · как исполнитель')).toBeInTheDocument();
    expect(within(metrics).getByText('Оплачено в срок · как заказчик')).toBeInTheDocument();
    expect(
      within(metrics).getByText('Принято без затягивания · как заказчик'),
    ).toBeInTheDocument();
  });

  it('подсказка зоны: сколько ещё событий до зелёной', async () => {
    renderPage();
    const metrics = await screen.findByTestId('insights-metrics');
    // «оплачено в срок» 3/6 = 50 % — оранжевая зона, to_green: 6.
    expect(within(metrics).getByText(/Оранжевая зона/)).toBeInTheDocument();
    expect(within(metrics).getByText(/ещё 6 в срок/)).toBeInTheDocument();
  });

  it('зелёной метрике подсказки «сколько осталось» не показывают', async () => {
    renderPage();
    const metrics = await screen.findByTestId('insights-metrics');
    const green = within(metrics).getAllByText(/Зелёная зона/);
    expect(green.length).toBeGreaterThan(0);
    green.forEach((node) => expect(node.textContent).not.toMatch(/ещё \d+/));
  });

  it('раскрытие закрыто по умолчанию и показывает конкретный этап с причиной', async () => {
    renderPage();
    const metrics = await screen.findByTestId('insights-metrics');
    expect(within(metrics).queryByText('Швы не затёрты по всей длине')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('insights-expand-first_time-contractor'));
    expect(screen.getByText('Штукатурка стен')).toBeInTheDocument();
    expect(screen.getByText(/Швы не затёрты по всей длине/)).toBeInTheDocument();
  });

  it('автоприёмка по тайм-ауту названа своими словами, а не кодом', async () => {
    renderPage();
    await screen.findByTestId('insights-metrics');
    await userEvent.click(screen.getByTestId('insights-expand-prompt_acceptance-customer'));
    expect(screen.getByText(/принято автоматически по истечении окна/)).toBeInTheDocument();
    expect(screen.queryByText(/auto_accepted/)).not.toBeInTheDocument();
  });

  it('блок «считается, но не показывается другим» — единственное место с объёмом', async () => {
    renderPage();
    const hidden = await screen.findByTestId('insights-hidden');
    expect(within(hidden).getByText(/4820000.00 RUB/)).toBeInTheDocument();
    expect(
      within(hidden).getByText('12 из 45 сделок с защищённым платежом'),
    ).toBeInTheDocument();
  });
});
