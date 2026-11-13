import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { DriveConnectCallbackPage } from '../src/pages/settings/DriveConnectCallbackPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { buildAuthorizeUrl, completeGoogleLogin } from '../src/mocks/authGlobalDb';

function renderWithProviders(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/settings/drive/callback" element={<DriveConnectCallbackPage />} />
            <Route path="/me/settings" element={<div data-testid="navigated-settings" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Тот же обход UI, что в ConsentsPage.test.tsx — уже залогиненный пользователь,
 * без него `POST /users/me/drive/connect/callback` вернул бы 401. */
function loginAsGoogleUser(): void {
  const { state } = buildAuthorizeUrl();
  completeGoogleLogin('sub-drive-1|drive-user@example.com', state);
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
}

describe('DriveConnectCallbackPage (ADR-084, EVIDENCE_DRIVE_PROVIDER=real) — приём callback', () => {
  beforeEach(() => {
    useActorStore.getState().reset();
    loginAsGoogleUser();
  });

  it('code+state валидны — обменивает код, показывает «Drive подключён» и уходит в /me/settings', async () => {
    renderWithProviders('/settings/drive/callback?code=google-code&state=drive-state-1');
    expect(screen.getByText('Подключаем Google Drive…')).toBeInTheDocument();
    expect(await screen.findByText('Google Drive подключён')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('navigated-settings')).toBeInTheDocument(), { timeout: 2000 });
  });

  it('Google вернул error= (отказ пользователя) — экран отказа, «Повторить» уводит в /me/settings', async () => {
    renderWithProviders('/settings/drive/callback?error=access_denied');
    const retry = await screen.findByRole('button', { name: 'Повторить' });
    expect(screen.getByRole('heading', { name: 'Вы отклонили доступ Google — попробуйте снова.' })).toBeInTheDocument();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('navigated-settings')).toBeInTheDocument());
  });

  it('нет code/state в URL — общий экран ошибки', async () => {
    renderWithProviders('/settings/drive/callback');
    expect(await screen.findByRole('heading', { name: 'Не удалось подключить Google Drive' })).toBeInTheDocument();
  });
});
