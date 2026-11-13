import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ProfileSettingsPage } from '../src/pages/settings/ProfileSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  const router = createMemoryRouter([{ path: '/', element: <ProfileSettingsPage /> }], { initialEntries: ['/'] });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Валидация формы профиля (zod 4 + @hookform/resolvers 5): прежние сообщения, валидный ввод сохраняется. */
describe('ProfileSettingsPage — валидация формы', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
  });

  it('пустое имя → «Укажите имя», кнопка «Сохранить» заблокирована', async () => {
    renderPage();
    const name = await screen.findByLabelText('Имя');
    await waitFor(() => expect(name).not.toHaveValue(''));
    await userEvent.clear(name);
    expect(await screen.findByText('Укажите имя')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('невалидный хендл → прежнее сообщение', async () => {
    renderPage();
    const handle = await screen.findByLabelText(/Хендл/);
    await waitFor(() => expect(handle).not.toHaveValue(''));
    await userEvent.clear(handle);
    await userEvent.type(handle, '@ab');
    expect(await screen.findByText('Хендл: латиница/цифры/подчёркивание, 3–20 символов')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('валидный ввод → отправка и «Сохранено»', async () => {
    renderPage();
    const name = await screen.findByLabelText('Имя');
    await waitFor(() => expect(name).not.toHaveValue(''));
    await userEvent.clear(name);
    await userEvent.type(name, 'Новое Имя');
    const save = screen.getByRole('button', { name: 'Сохранить' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
  });
});
