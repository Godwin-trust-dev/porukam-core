import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ConsentsPage } from '../src/pages/onboarding/ConsentsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { buildAuthorizeUrl, completeGoogleLogin, getGlobalConsents } from '../src/mocks/authGlobalDb';

function renderWithProviders(ui: React.ReactElement, locale: 'en' | 'ru' = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n(locale);
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/onboarding/consents']}>{ui}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Мок-логин через Google в обход UI — та же цепочка, что `GoogleMockPage` +
 * `AuthCallbackPage`, только напрямую по функциям `authGlobalDb`. */
function loginAsFreshGoogleUser(): void {
  const { state } = buildAuthorizeUrl();
  completeGoogleLogin('sub-cold-1|newcomer@example.com', state);
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
}

describe('ConsentsPage (DEV-auth-onboarding §5) — «Данные и приватность»', () => {
  beforeEach(() => {
    useActorStore.getState().reset();
    loginAsFreshGoogleUser();
  });

  it('изначально ничего не предзаполнено — оба согласия сняты, видимость не выбрана', async () => {
    renderWithProviders(<ConsentsPage />);
    await screen.findByRole('button', { name: 'Continue' });
    for (const cb of screen.getAllByRole('checkbox')) expect(cb).not.toBeChecked();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toHaveAttribute('aria-checked', 'false');
  });

  it('«Continue» активна только при обоих обязательных согласиях + выбранной видимости', async () => {
    renderWithProviders(<ConsentsPage />);
    const continueBtn = await screen.findByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();

    const agreeChecks = screen.getAllByRole('checkbox', { name: 'I agree' });
    await userEvent.click(agreeChecks[0]!); // «Ваши данные»
    expect(continueBtn).toBeDisabled();

    await userEvent.click(screen.getByText('Public profile')); // видимость выбрана, но 2-е согласие ещё нет
    expect(continueBtn).toBeDisabled();

    await userEvent.click(agreeChecks[1]!); // «Ваша карточка репутации»
    expect(continueBtn).not.toBeDisabled();
  });

  it('видимость можно выбрать любую из двух — второй вариант тоже включает продолжение', async () => {
    renderWithProviders(<ConsentsPage />);
    const continueBtn = await screen.findByRole('button', { name: 'Continue' });
    const agreeChecks = screen.getAllByRole('checkbox', { name: 'I agree' });
    await userEvent.click(agreeChecks[0]!);
    await userEvent.click(agreeChecks[1]!);
    await userEvent.click(screen.getByText('Only by link and in deals'));
    expect(continueBtn).not.toBeDisabled();
  });

  it('«Continue» сохраняет согласия на бэке (мок): completed=true, phone_discoverability=false', async () => {
    renderWithProviders(<ConsentsPage />);
    const continueBtn = await screen.findByRole('button', { name: 'Continue' });
    const agreeChecks = screen.getAllByRole('checkbox', { name: 'I agree' });
    await userEvent.click(agreeChecks[0]!);
    await userEvent.click(agreeChecks[1]!);
    await userEvent.click(screen.getByText('Public profile'));
    await userEvent.click(continueBtn);

    await waitFor(() => {
      const consents = getGlobalConsents();
      expect(consents.completed).toBe(true);
      expect(consents.profile_public).toBe(true);
      expect(consents.phone_discoverability).toBe(false);
    });
  });

  // docs/tasks/Задача_fix_web-consents-crash.md §2 — форс `useForceLocale('en')` снят,
  // экран обязан уважать язык интерфейса (тут — заданный тестом i18n напрямую, как и
  // остальной UI после fix/web-locales-switcher).
  it('без форса языка — на ru показывает русский перевод (packages/i18n/locales/ru/onboarding.json)', async () => {
    renderWithProviders(<ConsentsPage />, 'ru');
    expect(await screen.findByRole('heading', { name: 'Данные и приватность' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Продолжить' })).toBeInTheDocument();
    expect(screen.getByText('Читать полностью')).toBeInTheDocument();
  });

  // docs/tasks/Задача_fix_web-consents-crash.md, «Дополнительно» — «Read in full» была
  // мёртвой кнопкой (readMoreLabel без onReadMore). Теперь раскрывает `dataFullText`.
  it('«Read in full» раскрывает полный текст согласия и сворачивает обратно по повторному клику', async () => {
    renderWithProviders(<ConsentsPage />);
    const readMoreBtn = await screen.findByRole('button', { name: 'Read in full' });
    expect(readMoreBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/We store what you and your counterparty record/)).not.toBeInTheDocument();

    await userEvent.click(readMoreBtn);
    expect(readMoreBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/We store what you and your counterparty record/)).toBeInTheDocument();

    await userEvent.click(readMoreBtn);
    expect(readMoreBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/We store what you and your counterparty record/)).not.toBeInTheDocument();
  });
});
