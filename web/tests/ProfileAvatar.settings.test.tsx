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
import { getProfileSettings } from '../src/mocks/profilesDb';

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

/** Фото профиля (ADR-103, docs/tasks/Задача_feat_profiles-avatar.md):
 * POST/DELETE /profiles/{id}/avatar, ошибки 413/422 инлайн. */
describe('ProfileSettingsPage — фото профиля (ADR-103)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
  });

  it('без фото — инициалы и только «Сменить фото»; после загрузки — <img> и «Удалить фото»', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Сменить фото' });
    expect(screen.queryByRole('button', { name: 'Удалить фото' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Фото профиля' })).not.toBeInTheDocument();

    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'me.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('avatar-file-input'), file);

    const img = await screen.findByRole('img', { name: 'Фото профиля' });
    expect(img).toHaveAttribute('src', expect.stringContaining('/v1/profiles/pf-person-1/avatar?size=256&v='));
    expect(getProfileSettings('pf-person-1')?.avatar_url).toBe(img.getAttribute('src'));
    expect(screen.getByRole('button', { name: 'Удалить фото' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Удалить фото' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Фото профиля' })).not.toBeInTheDocument());
    expect(getProfileSettings('pf-person-1')?.avatar_url).toBeNull();
  });

  it('не-изображение → «Файл не распознан как изображение», фото не меняется', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Сменить фото' });
    const file = new File(['not an image'], 'doc.txt', { type: 'text/plain' });
    await userEvent.upload(screen.getByTestId('avatar-file-input'), file, { applyAccept: false });

    expect(await screen.findByTestId('avatar-error')).toHaveTextContent('Файл не распознан как изображение');
    expect(getProfileSettings('pf-person-1')?.avatar_url).toBeNull();
  });

  it('больше 5 МБ → «Файл больше 5 МБ»', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Сменить фото' });
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('avatar-file-input'), big);

    expect(await screen.findByTestId('avatar-error')).toHaveTextContent('Файл больше 5 МБ');
  });
});
