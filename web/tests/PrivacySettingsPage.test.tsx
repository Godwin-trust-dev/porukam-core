import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { PrivacySettingsPage } from '../src/pages/settings/PrivacySettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <PrivacySettingsPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * docs/tasks/Задача_fix_web-profile-settings-real-api.md, ADR-087 — реальный
 * контракт: profile_visibility/hide_from_catalog/show_name/avatar_visibility
 * через `PATCH /profiles/{id}` (apps.profiles), findableByPhone через
 * `POST /users/me/consents` (apps.social). Раньше страница била в
 * несуществующий `PATCH /users/me/settings` и молча ничего не сохраняла.
 */
describe('PrivacySettingsPage (DEV-02 §5, ADR-059/ADR-087)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
  });

  it('читает реальные значения при загрузке (сид pf-person-1: public/не скрыт/показывает имя/публичный аватар)', async () => {
    renderPage();
    expect(await screen.findByLabelText('Кто видит карточку')).toHaveValue('public');
    expect(screen.getByRole('switch', { name: 'Не показывать в каталоге' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Показывать только @хендл' })).not.toBeChecked();
    expect(screen.getByLabelText('Кто видит ваше фото')).toHaveValue('public');
  });

  it('смена «Кто видит карточку» — реально сохраняется (PATCH /profiles/{id}), видна при повторном заходе', async () => {
    const { unmount } = renderPage();
    const select = await screen.findByLabelText('Кто видит карточку');
    await userEvent.selectOptions(select, 'link_and_deals');
    await waitFor(() => expect(select).toHaveValue('link_and_deals'));

    unmount();
    renderPage();
    await waitFor(async () => expect(await screen.findByLabelText('Кто видит карточку')).toHaveValue('link_and_deals'));
  });

  it('«Показывать только @хендл» — инвертирован относительно Profile.show_name, сохраняется', async () => {
    const { unmount } = renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Показывать только @хендл' });
    expect(toggle).not.toBeChecked(); // show_name=true (сид) → тумблер выключен
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());

    unmount();
    renderPage();
    await waitFor(async () => expect(await screen.findByRole('switch', { name: 'Показывать только @хендл' })).toBeChecked());
  });

  it('«Находимость по телефону» — идёт через POST /users/me/consents (apps.social), не PATCH /profiles', async () => {
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Находимость по телефону' });
    // Сид (profileDb.ts:myConsents) — phone_discoverability: true.
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});
