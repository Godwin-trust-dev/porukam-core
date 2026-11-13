import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ProfileStepPage } from '../src/pages/onboarding/ProfileStepPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { buildAuthorizeUrl, completeGoogleLogin } from '../src/mocks/authGlobalDb';
import { server } from '../src/mocks/server';

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('en');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/onboarding/profile']}>{ui}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Та же обвязка, но с реальным роутингом — нужна проверить факт перехода
 * на /onboarding/backup после успешного сабмита (docs/tasks/
 * Задача_fix_web-profile-handle-real-api.md §6). */
function renderWithRouting() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('en');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/onboarding/profile']}>
          <Routes>
            <Route path="/onboarding/profile" element={<ProfileStepPage />} />
            <Route path="/onboarding/backup" element={<div data-testid="navigated-backup" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function loginAsFreshGoogleUser(): void {
  const { state } = buildAuthorizeUrl();
  completeGoogleLogin('sub-cold-1|newcomer@example.com', state);
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
}

describe('ProfileStepPage (DEV-auth-onboarding §6) — @handle обязателен, проверка занятости', () => {
  beforeEach(() => {
    useActorStore.getState().reset();
    loginAsFreshGoogleUser();
  });

  it('занятый @handle → «Taken», «Continue» недоступна', async () => {
    renderWithProviders(<ProfileStepPage />);
    const handleInput = await screen.findByRole('textbox', { name: '@handle' });

    await userEvent.clear(handleInput);
    await userEvent.type(handleInput, 'teplo_remont');
    await waitFor(() => expect(screen.getByText('Taken')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('свободный @handle → «Available», «Continue» доступна', async () => {
    renderWithProviders(<ProfileStepPage />);
    const handleInput = await screen.findByRole('textbox', { name: '@handle' });

    await userEvent.clear(handleInput);
    await userEvent.type(handleInput, 'brandnewglobal1');
    await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled();
  });

  it('@handle предлагается из имени/почты, но не блокирует правку', async () => {
    renderWithProviders(<ProfileStepPage />);
    const handleInput = await screen.findByRole('textbox', { name: '@handle' });
    // Свежий Google-аккаунт без handle — компонент предлагает что-то непустое (§6 «предложить из имени/почты»).
    await waitFor(() => expect((handleInput as HTMLInputElement).value.length).toBeGreaterThan(0));
  });

  // docs/tasks/Задача_fix_web-consents-crash.md — `TypeError: Cannot read
  // properties of undefined (reading 'replace')`. Мок (см. authGlobalDb.ts
  // freshUser) с Задача_fix_web-profile-handle-real-api.md сам отдаёт `handle:
  // null`/полный `settings`, но здесь имитируем ЕЩЁ более голый реальный ответ
  // (`display_name`/`settings` тоже отсутствуют вовсе, не просто null) — та
  // форма, что реально шлёт `UserMeSerializer` до этой задачи. `profiles` —
  // НЕ `[]` (Задача_fix_web-profile-settings-real-api.md, ADR-087): person-
  // профиль реально существует уже на регистрации (subscriber apps.profiles
  // на `account.logged_in`), `GET /profiles/{id}` — общий мок-хендлер ниже
  // (`profilesHandlers.ts`) сам заведёт дефолты для незнакомого id.
  it('реальная форма /v1/users/me без handle/display_name/settings — не падает, поля стартуют пустыми', async () => {
    server.use(
      http.get('/v1/users/me', () =>
        HttpResponse.json({
          id: 'u-real-1',
          phone: '',
          email: 'newcomer@example.com',
          verification_level: 'none',
          has_business_status: false,
          profiles: [{ id: 'pf-real-1', kind: 'person', display_name: '', handle: '', verification_level: 'none', has_business_status: false }],
          // handle/display_name/settings — намеренно отсутствуют (реальный контракт).
        }),
      ),
    );
    renderWithProviders(<ProfileStepPage />);

    const nameInput = await screen.findByRole('textbox', { name: 'Name' });
    const handleInput = screen.getByRole('textbox', { name: '@handle' });
    expect(nameInput).toHaveValue('');
    expect(handleInput).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled(); // пустое имя — не готово

    // Экран не мёртв — можно набрать значения вручную и продолжить.
    await userEvent.type(nameInput, 'New Comer');
    await userEvent.type(handleInput, 'newcomer1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled());
  });

  // docs/tasks/Задача_fix_web-profile-handle-real-api.md — «Продолжить» теперь
  // реально пишет: сперва POST /users/me/handle (apps.social, useClaimHandle),
  // потом PATCH /users/me (имя), потом переход дальше — не просто разблокирует
  // кнопку.
  describe('сабмит — POST /users/me/handle (§4)', () => {
    it('ADR-122: выбранные сферы уходят в PATCH /profiles/{id} вместе с show_name', async () => {
      const patches: unknown[] = [];
      server.use(
        http.patch('/v1/profiles/:id', async ({ request }) => {
          const body = await request.json();
          patches.push(body);
          return HttpResponse.json({ id: 'pf-person-1', kind: 'person', display_name: 'X', profile_visibility: 'public', hide_from_catalog: false, show_name: true, avatar_visibility: 'public', avatar_url: null, city_name: '', works_remotely: false, sphere_codes: (body as { sphere_codes?: string[] }).sphere_codes ?? [] });
        }),
      );
      renderWithRouting();
      const nameInput = await screen.findByRole('textbox', { name: 'Name' });
      const handleInput = screen.getByRole('textbox', { name: '@handle' });
      await userEvent.clear(handleInput);
      await userEvent.type(handleInput, 'spheresuser1');
      await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument());
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'Sphere User');
      // Подсказка «по этим сферам вас найдут заказчики» и выбор сферы из каталога.
      expect(screen.getByTestId('onboarding-spheres')).toBeInTheDocument();
      await userEvent.click(await screen.findByTestId('sphere-repair'));
      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(screen.getByTestId('navigated-backup')).toBeInTheDocument());
      expect(patches).toContainEqual(expect.objectContaining({ sphere_codes: ['repair'] }));
    });

    it('свободный handle — claim проходит, ведёт на /onboarding/backup', async () => {
      renderWithRouting();
      const nameInput = await screen.findByRole('textbox', { name: 'Name' });
      const handleInput = screen.getByRole('textbox', { name: '@handle' });

      await userEvent.clear(handleInput);
      await userEvent.type(handleInput, 'brandnewglobal1');
      await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument());
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'New Global');

      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(screen.getByTestId('navigated-backup')).toBeInTheDocument());
    });

    it('409 handle_taken при сабмите (гонка мимо живой проверки) — «Taken», шаг не «полусохраняется»', async () => {
      renderWithRouting();
      const nameInput = await screen.findByRole('textbox', { name: 'Name' });
      const handleInput = screen.getByRole('textbox', { name: '@handle' });

      // Живая проверка (`GET /users/handle-available`) считает его свободным —
      // «Продолжить» разблокирована, — но САБМИТ (`POST /users/me/handle`)
      // получает 409: другой пользователь успел занять этот же handle первым.
      server.use(
        http.post('/v1/users/me/handle', () =>
          HttpResponse.json(
            { status: 409, code: 'handle_taken', title: 'handle_taken', detail: 'Этот хендл уже занят.' },
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
          ),
        ),
      );

      await userEvent.clear(handleInput);
      await userEvent.type(handleInput, 'brandnewglobal1');
      await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument());
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'New Global');

      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(screen.getByText('Taken')).toBeInTheDocument());
      expect(screen.queryByTestId('navigated-backup')).not.toBeInTheDocument(); // не ушли дальше
    });

    it('422 invalid_handle_format при сабмите — понятная ошибка инлайн', async () => {
      renderWithRouting();
      const nameInput = await screen.findByRole('textbox', { name: 'Name' });
      const handleInput = screen.getByRole('textbox', { name: '@handle' });

      server.use(
        http.post('/v1/users/me/handle', () =>
          HttpResponse.json(
            {
              status: 422,
              code: 'invalid_handle_format',
              title: 'invalid_handle_format',
              detail: 'Хендл — 3–32 символа.',
            },
            { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
          ),
        ),
      );

      await userEvent.clear(handleInput);
      await userEvent.type(handleInput, 'brandnewglobal1');
      await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument());
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'New Global');

      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/@handle/));
      expect(screen.queryByTestId('navigated-backup')).not.toBeInTheDocument();
    });
  });
});
