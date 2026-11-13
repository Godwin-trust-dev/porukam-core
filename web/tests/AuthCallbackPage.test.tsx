import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { AuthCallbackPage } from '../src/pages/auth/AuthCallbackPage';
import { useActorStore } from '../src/features/actor/actorStore';
import { useAuthStore } from '../src/features/auth/authStore';
import { buildAuthorizeUrl } from '../src/mocks/authGlobalDb';

/**
 * Реальный (не мок-обход) флоу приёма Google-логина на боевом пути
 * `/auth/google/callback` (docs/tasks/Задача_feat_web-oauth-callbacks.md
 * §2.2, вариант Б) — рендерим страницу напрямую, GoogleCallback идёт через
 * MSW-хендлер `POST /auth/google/callback`, тот же контур, что `GoogleMockPage`
 * использует при клике «Продолжить».
 */
function renderWithProviders(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('en'); // AuthCallbackPage форсит en (useForceLocale)
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/auth/google/callback" element={<AuthCallbackPage />} />
            <Route path="/onboarding/consents" element={<div data-testid="navigated-consents" />} />
            <Route path="/welcome" element={<div data-testid="navigated-welcome" />} />
            <Route path="/" element={<div data-testid="navigated-app" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('AuthCallbackPage on /auth/google/callback (боевой redirect_uri логина) — приём callback', () => {
  beforeEach(() => {
    useActorStore.getState().reset();
    useAuthStore.getState().logout();
  });

  it('code+state валидны — обменивает код и уводит нового пользователя в /onboarding/consents', async () => {
    const { state } = buildAuthorizeUrl();
    renderWithProviders(
      `/auth/google/callback?code=${encodeURIComponent('sub-cb-1|cb1@example.test')}&state=${state}`,
    );
    expect(screen.getByText('Signing you in…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('navigated-consents')).toBeInTheDocument());
  });

  it('Google вернул error= (отказ пользователя) — экран отказа, «Try again» уводит на /welcome', async () => {
    renderWithProviders('/auth/google/callback?error=access_denied&state=whatever');
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(
      screen.getByRole('heading', { name: 'You declined Google access — sign in again to continue.' }),
    ).toBeInTheDocument();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('navigated-welcome')).toBeInTheDocument());
  });

  it('нет code/state в URL — общий экран ошибки', async () => {
    renderWithProviders('/auth/google/callback');
    expect(await screen.findByRole('heading', { name: "Couldn't sign you in with Google" })).toBeInTheDocument();
  });

  it('повторный заход на callback при живой сессии — молча в приложение, не «вход не удался» (прод 2026-08-24)', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' }, 'google');
    renderWithProviders('/auth/google/callback?code=used-code&state=replayed-state');
    await waitFor(() => expect(screen.getByTestId('navigated-app')).toBeInTheDocument());
    expect(screen.queryByTestId('navigated-welcome')).not.toBeInTheDocument();
  });

  it('неизвестный state — 422 от бэка → экран ошибки с доменным кодом', async () => {
    renderWithProviders('/auth/google/callback?code=sub-cb-2|cb2@example.test&state=does-not-exist');
    expect(await screen.findByRole('heading', { name: "Couldn't sign you in with Google" })).toBeInTheDocument();
    expect(screen.getByText('code: google_oauth_state_invalid')).toBeInTheDocument();
  });
});
