import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { GroupDetailPage } from '../src/pages/GroupDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { resetGroups } from '../src/mocks/groupsHandlers';
import { resetGroupPortfolio } from '../src/mocks/groupPortfolioHandlers';

/**
 * Портфолио объединения (ADR-128): витрина работ на карточке объединения —
 * лидер наполняет и правит, посторонний только смотрит.
 * `pf-mock-contractor-1` — лидер `grp-1` в моках.
 */

function renderGroup(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/groups/grp-1']}>
          <Routes>
            <Route path="/groups/:groupId" element={<GroupDetailPage />} />
            <Route path="/reputation/profiles/:profileId" element={<div data-testid="profile-page" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Портфолио объединения (ADR-128)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-mock-contractor-1' });
    resetGroups();
    resetGroupPortfolio();
  });

  it('работы объединения видны и кликабельны — открывается просмотр с галереей', async () => {
    renderGroup();
    const list = await screen.findByTestId('group-portfolio-list');
    expect(within(list).getByText('Отделка кофейни на Абая')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('group-work-gpp-1'));
    const view = await screen.findByTestId('project-view');
    expect(within(view).getByTestId('project-view-description')).toHaveTextContent('барная стойка');
    // Две фотографии — доступно листание.
    expect(within(view).getByText('Фото 1 из 2')).toBeInTheDocument();
  });

  it('лидер добавляет работу: дата завершения обязательна, начало позже завершения отвергается', async () => {
    renderGroup();
    await screen.findByTestId('group-portfolio-list');

    await userEvent.click(screen.getByTestId('group-portfolio-add'));
    await userEvent.type(screen.getByTestId('portfolio-title'), 'Ремонт офиса');
    await userEvent.click(screen.getByTestId('portfolio-form-submit'));
    expect(await screen.findByText('Укажите дату завершения')).toBeInTheDocument();

    await userEvent.type(screen.getByTestId('portfolio-started-at'), '2026-07-01');
    await userEvent.type(screen.getByTestId('portfolio-completed-at'), '2026-06-01');
    await userEvent.click(screen.getByTestId('portfolio-form-submit'));
    expect(await screen.findByText('Дата начала позже даты завершения')).toBeInTheDocument();

    await userEvent.clear(screen.getByTestId('portfolio-completed-at'));
    await userEvent.type(screen.getByTestId('portfolio-completed-at'), '2026-08-01');
    await userEvent.type(screen.getByTestId('portfolio-city'), 'Астана');
    await userEvent.click(screen.getByTestId('portfolio-form-submit'));

    await waitFor(() => expect(screen.getByText('Ремонт офиса')).toBeInTheDocument());
    expect(screen.getByText(/Астана/)).toBeInTheDocument();
  });

  it('лидер редактирует работу', async () => {
    renderGroup();
    await screen.findByTestId('group-portfolio-list');

    await userEvent.click(screen.getByTestId('group-work-edit-gpp-1'));
    const title = await screen.findByTestId('portfolio-title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Кофейня на Абая — второй этап');
    await userEvent.click(screen.getByTestId('portfolio-form-submit'));

    await waitFor(() => expect(screen.getByText('Кофейня на Абая — второй этап')).toBeInTheDocument());
  });

  it('удаление работы — в два шага, после подтверждения работа исчезает', async () => {
    renderGroup();
    await screen.findByTestId('group-portfolio-list');
    expect(screen.getByText('Отделка кофейни на Абая')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('group-work-delete-gpp-1'));
    // Первый клик только спрашивает — работа на месте.
    expect(screen.getByText('Отделка кофейни на Абая')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('group-work-delete-confirm-gpp-1'));
    await waitFor(() => expect(screen.queryByText('Отделка кофейни на Абая')).not.toBeInTheDocument());
  });

  it('галерея: смена основного фото и удаление фото', async () => {
    renderGroup();
    await screen.findByTestId('group-portfolio-photos-gpp-1');

    await userEvent.click(screen.getByTestId('group-photo-primary-gph-2'));
    await waitFor(() => expect(screen.queryByTestId('group-photo-primary-gph-2')).not.toBeInTheDocument());
    // Основным стало второе — «сделать основным» теперь предлагается первому.
    expect(screen.getByTestId('group-photo-primary-gph-1')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('group-photo-remove-gph-1'));
    await waitFor(() => expect(screen.queryByTestId('group-photo-remove-gph-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('group-photo-remove-gph-2')).toBeInTheDocument();
  });

  it('посторонний видит работы, но не видит кнопок управления', async () => {
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
    renderGroup();

    const list = await screen.findByTestId('group-portfolio-list');
    expect(within(list).getByText('Отделка кофейни на Абая')).toBeInTheDocument();
    expect(screen.queryByTestId('group-portfolio-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-work-edit-gpp-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-work-delete-gpp-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-portfolio-photos-gpp-1')).not.toBeInTheDocument();
  });
});
