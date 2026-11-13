import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { EmailLoginPage } from '../src/pages/EmailLoginPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { MOCK_EMAIL_DISABLED, MOCK_EMAIL_RATE_LIMITED } from '../src/mocks/emailAuthHandlers';

/**
 * Вход/регистрация по e-mail кодом (ADR-168) — экран `/login/email` против
 * MSW-зеркала контракта (`src/mocks/emailAuthHandlers.ts`). Реальный бэк
 * строится параллельно; сюда вынесены ровно те ветки, на которые экран обязан
 * отвечать по-разному: успех, неверный код, «слишком часто», выключенный
 * канал.
 */
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('en');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/login/email']}>
          <Routes>
            <Route path="/login/email" element={<EmailLoginPage />} />
            <Route path="/welcome" element={<div data-testid="navigated-welcome" />} />
            <Route path="/" element={<div data-testid="navigated-app" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Шаг 1: адрес + согласие юрканала + «Get code». */
async function requestCode(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.type(screen.getByLabelText('Email address'), email);
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Get code' }));
}

describe('EmailLoginPage — вход по коду из письма', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
    localStorage.clear();
  });

  it('шаг адреса → шаг кода: нейтральное уведомление об отправке и dev-подсказка', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Sign in with email' })).toBeInTheDocument();

    await requestCode(user, 'person@example.com');

    expect(await screen.findByRole('heading', { name: 'Code from the email' })).toBeInTheDocument();
    // Существование аккаунта не раскрывается — только «если адрес верный».
    expect(screen.getByText(/If the address is correct/i)).toBeInTheDocument();
    expect(screen.getByText(/Test mode: code — 111111/)).toBeInTheDocument();
  });

  it('верный код — токены в сторе и переход в приложение', async () => {
    const user = userEvent.setup();
    renderPage();
    await requestCode(user, 'person@example.com');

    await user.type(await screen.findByLabelText('Confirmation code'), '111111');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('login-success')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('navigated-app')).toBeInTheDocument());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    // Сессия НЕ помечена google — гард онбординга GLOBAL спрашивает согласия
    // только у Google-входа, e-mail идёт тем же путём, что OTP.
    expect(useAuthStore.getState().loginMethod).toBe('otp');
  });

  it('неверный код (otp_invalid_code) — человеческая ошибка, экран остаётся на шаге кода', async () => {
    const user = userEvent.setup();
    renderPage();
    await requestCode(user, 'person@example.com');

    await user.type(await screen.findByLabelText('Confirmation code'), '222222');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid code. Check it and try again.')).toBeInTheDocument();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('лимит запросов (otp_rate_limited) — обратный отсчёт вместо повторной отправки', async () => {
    const user = userEvent.setup();
    renderPage();
    await requestCode(user, MOCK_EMAIL_RATE_LIMITED);

    expect(await screen.findByText('Too many attempts. Try again in 30s.')).toBeInTheDocument();
    // Шаг кода не открылся, кнопка показывает паузу и недоступна.
    expect(screen.queryByRole('heading', { name: 'Code from the email' })).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Resend \(in 30s\)/ });
    expect(button).toBeDisabled();
  });

  it('канал выключен (403 email_login_disabled) — тупик с единственной дверью в Google', async () => {
    const user = userEvent.setup();
    renderPage();
    await requestCode(user, MOCK_EMAIL_DISABLED);

    expect(await screen.findByTestId('email-login-disabled')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Email sign-in is off' })).toBeInTheDocument();
    // Поля адреса больше нет — повторять запрос бессмысленно.
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(screen.getByTestId('navigated-welcome')).toBeInTheDocument();
  });

  it('под полем кода — срок годности кода, а не отсчёт повторной отправки', async () => {
    const user = userEvent.setup();
    renderPage();
    await requestCode(user, 'person@example.com');

    // Замечание владельца 07.09: единственным числом на экране был отсчёт
    // «Resend in 60s», и он читался как срок жизни кода.
    const validity = await screen.findByTestId('email-code-validity');
    expect(validity).toHaveTextContent('The code is valid for 15 min.');
    expect(validity).toHaveTextContent(/spam/i);
  });
});
