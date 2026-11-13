import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { PortfolioPage } from '../src/pages/PortfolioPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { resetPortfolio } from '../src/mocks/portfolioHandlers';

/** Портфолио (ADR-115 → ADR-120): даты, редактирование, галерея до 5 фото, просмотр. */

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/me/portfolio']}>
          <PortfolioPage />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

async function createWork(title: string, completedAt = '2026-05-01'): Promise<void> {
  await userEvent.click(screen.getByTestId('portfolio-add'));
  await userEvent.type(screen.getByTestId('portfolio-title'), title);
  if (completedAt) await userEvent.type(screen.getByTestId('portfolio-completed-at'), completedAt);
  await userEvent.click(screen.getByTestId('portfolio-form-submit'));
}

describe('Портфолио', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
    resetPortfolio();
  });

  it('пустое портфолио своего профиля → добавить работу (дата обязательна) → публикация', async () => {
    renderPage();
    expect(await screen.findByText('Работ пока нет')).toBeInTheDocument();

    // Без даты завершения — ошибка у поля, запроса нет.
    await createWork('Кухня из массива', '');
    expect(await screen.findByText('Укажите дату завершения')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('portfolio-completed-at'), '2026-05-01');
    await userEvent.type(screen.getByTestId('portfolio-city'), 'Астана');
    await userEvent.click(screen.getByTestId('portfolio-form-submit'));

    const list = await screen.findByTestId('portfolio-list');
    expect(within(list).getByText('Кухня из массива')).toBeInTheDocument();
    expect(within(list).getByText('Черновик')).toBeInTheDocument();
    expect(within(list).getByText(/Астана/)).toBeInTheDocument();
    expect(within(list).getByText(/Завершено/)).toBeInTheDocument();

    await userEvent.click(within(list).getByText('Опубликовать'));
    await waitFor(() => expect(within(list).getByText('Опубликована')).toBeInTheDocument());
  });

  it('дата начала позже даты завершения — ошибка до запроса', async () => {
    renderPage();
    await screen.findByText('Работ пока нет');
    await userEvent.click(screen.getByTestId('portfolio-add'));
    await userEvent.type(screen.getByTestId('portfolio-title'), 'Наоборот');
    await userEvent.type(screen.getByTestId('portfolio-started-at'), '2026-06-01');
    await userEvent.type(screen.getByTestId('portfolio-completed-at'), '2026-05-01');
    await userEvent.click(screen.getByTestId('portfolio-form-submit'));
    expect(await screen.findByText('Дата начала позже даты завершения')).toBeInTheDocument();
  });

  it('редактирование работы: сфера, даты, описание', async () => {
    renderPage();
    await screen.findByText('Работ пока нет');
    await createWork('Веранда');
    const list = await screen.findByTestId('portfolio-list');
    const edit = within(list).getByTestId(/portfolio-edit-/);
    await userEvent.click(edit);
    await userEvent.selectOptions(screen.getByTestId('portfolio-sphere'), 'design');
    await userEvent.type(screen.getByTestId('portfolio-started-at'), '2026-04-01');
    await userEvent.type(screen.getByTestId('portfolio-description'), 'Много подробностей о работе.');
    await userEvent.click(screen.getByTestId('portfolio-form-submit'));
    await waitFor(() => expect(within(list).getByText('Дизайн')).toBeInTheDocument());
    expect(within(list).getByText('Много подробностей о работе.')).toBeInTheDocument();
    expect(within(list).getAllByText(/—/).length).toBeGreaterThan(0); // период «начало — завершение»
  });

  it('галерея: до 5 фото, первое — основное, смена основного и удаление', async () => {
    renderPage();
    await screen.findByText('Работ пока нет');
    await createWork('Забор');
    const list = await screen.findByTestId('portfolio-list');
    const add = within(list).getByTestId(/portfolio-photo-add-/);
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    for (let i = 0; i < 5; i += 1) {
      await userEvent.click(within(list).getByTestId(/portfolio-photo-add-/));
      await userEvent.upload(screen.getByTestId('portfolio-photo-input'), file);
      await waitFor(() => expect(within(list).getByText(`Фото — ${i + 1} из 5`)).toBeInTheDocument());
    }
    void add;
    expect(within(list).getByText('Не больше 5 фото на работу')).toBeInTheDocument();
    expect(within(list).getAllByText('Сделать основным')).toHaveLength(4);
    expect(within(list).getByText('Основное')).toBeInTheDocument();

    const makePrimary = within(list).getAllByTestId(/portfolio-photo-primary-/)[0]!;
    const promotedId = makePrimary.getAttribute('data-testid')!.replace('portfolio-photo-primary-', '');
    await userEvent.click(makePrimary);
    await waitFor(() => expect(within(list).queryByTestId(`portfolio-photo-primary-${promotedId}`)).not.toBeInTheDocument());

    await userEvent.click(within(list).getAllByTestId(/portfolio-photo-remove-/)[0]!);
    await waitFor(() => expect(within(list).getByText('Фото — 4 из 5')).toBeInTheDocument());
  });
});
