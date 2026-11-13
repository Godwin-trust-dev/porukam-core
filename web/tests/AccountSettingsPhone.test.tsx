import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { AccountSettingsPage } from '../src/pages/settings/AccountSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/** Телефон в настройках аккаунта (вариант А, 2026-08-24): ввод «через +»,
 * нормализация перед сохранением, клиентская валидация формата. */

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/me/settings/account']}>
          <AccountSettingsPage />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Настройки аккаунта — телефон', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1', profiles: [] });
  });

  it('номер с пробелами и скобками нормализуется при сохранении', async () => {
    renderPage();
    const input = await screen.findByTestId('phone-input');
    await userEvent.type(input, '+7 (999) 020-00-99');
    await userEvent.click(screen.getByTestId('phone-save'));
    await waitFor(() => expect(screen.getByText('Номер сохранён')).toBeInTheDocument());
    expect((screen.getByTestId('phone-input') as HTMLInputElement).value).toBe('+79990200099');
  });

  it('номер без «+» отклоняется клиентской валидацией с подсказкой', async () => {
    renderPage();
    const input = await screen.findByTestId('phone-input');
    await userEvent.type(input, '89990200099');
    await userEvent.click(screen.getByTestId('phone-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('международном формате');
  });
});
