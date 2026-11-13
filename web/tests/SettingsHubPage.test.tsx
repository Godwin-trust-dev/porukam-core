import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { createI18n, en, ru } from '@porukam/i18n';
import { SettingsHubPage } from '../src/pages/settings/SettingsHubPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

function renderHub() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/me/settings']}>
          <SettingsHubPage />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * Хаб настроек узкого экрана (решение владельца 01.09, финал доска A) —
 * «ВИДИМОСТЬ» тумблерами и «АККАУНТ» строками-разделами.
 */
describe('SettingsHubPage', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
  });

  it('обе группы на месте: тумблеры видимости и строки разделов', async () => {
    renderHub();
    expect(await screen.findByTestId('settings-hub')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Аккаунт' })).toBeInTheDocument();
    expect(screen.getByTestId('settings-hub-privacy')).toBeInTheDocument();
  });

  /**
   * Решение владельца 05.09: «скрой его во всех локалях». Плашка
   * «Видимость не покупается…» с экрана убрана, ключ
   * `profile.hubVisibilityNote` снят из 29 локалей — проверяем и экран,
   * и то, что ключ действительно не воскрес в пакетах (иначе `t()` начал бы
   * снова отдавать текст, а не сам ключ).
   */
  it('плашки «видимость не покупается» на экране нет', async () => {
    renderHub();
    await screen.findByTestId('settings-hub');
    expect(screen.queryByText(/[Вв]идимость (нельзя|не)\s*(купить|покупается)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hubVisibilityNote/)).not.toBeInTheDocument();
  });

  it('ключ profile.hubVisibilityNote снят из канона и из русского пакета', () => {
    expect(en.profile).not.toHaveProperty('hubVisibilityNote');
    expect(ru.profile).not.toHaveProperty('hubVisibilityNote');
  });
});
