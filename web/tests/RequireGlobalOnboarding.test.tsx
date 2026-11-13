import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { createI18n } from '@porukam/i18n';
import { RequireGlobalOnboarding } from '../src/features/auth/RequireGlobalOnboarding';
import { useAuthStore } from '../src/features/auth/authStore';
import { server } from '../src/mocks/server';

/**
 * Прод-инцидент 2026-08-24 (вход с телефона): ошибка загрузки `/users/me`
 * или согласий выбрасывала давно онбордившегося человека на
 * `/onboarding/consents` с мёртвым «Повторить». Гард обязан редиректить
 * ТОЛЬКО по успешно загруженным данным; ошибка — ErrorState с ретраем.
 */

function renderGuarded(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={
                <RequireGlobalOnboarding>
                  <div data-testid="app-content" />
                </RequireGlobalOnboarding>
              }
            />
            <Route path="/onboarding/consents" element={<div data-testid="consents-page" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('RequireGlobalOnboarding — ошибка данных ≠ «онбординг не пройден»', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' }, 'google');
  });

  it('500 на /users/me → ошибка с ретраем НА МЕСТЕ, не редирект на согласия', async () => {
    server.use(
      http.get('/v1/users/me', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })),
    );
    renderGuarded();
    expect(await screen.findByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(screen.queryByTestId('consents-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-content')).not.toBeInTheDocument();
  });

  it('«Повторить» перезапрашивает упавший запрос — после восстановления сети пускает в приложение', async () => {
    let failures = 1;
    server.use(
      http.get('/v1/users/me', () => {
        if (failures > 0) {
          failures -= 1;
          return HttpResponse.json({ detail: 'boom' }, { status: 500 });
        }
        // Успех: онбординг пройден (handle есть).
        return HttpResponse.json({
          id: 'u-1',
          handle: '@masha',
          profiles: [],
        });
      }),
      http.get('/v1/users/me/privacy-consents-global', () =>
        HttpResponse.json({
          pd_processing: true,
          profile_public: true,
          phone_discoverability: false,
          reputation_history_basis: true,
          completed: true,
        }),
      ),
    );
    renderGuarded();
    await userEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('app-content')).toBeInTheDocument();
    expect(screen.queryByTestId('consents-page')).not.toBeInTheDocument();
  });

  it('успешно загруженные данные с НЕпройденным онбордингом — редирект на согласия работает', async () => {
    server.use(
      http.get('/v1/users/me', () => HttpResponse.json({ id: 'u-1', handle: null, profiles: [] })),
      http.get('/v1/users/me/privacy-consents-global', () =>
        HttpResponse.json({
          pd_processing: null,
          profile_public: null,
          phone_discoverability: null,
          reputation_history_basis: null,
          completed: false,
        }),
      ),
    );
    renderGuarded();
    await waitFor(() => expect(screen.getByTestId('consents-page')).toBeInTheDocument());
  });
});
