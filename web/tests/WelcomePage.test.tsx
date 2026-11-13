import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { WelcomePage } from '../src/pages/auth/WelcomePage';
import { markAccountDeleted } from '../src/features/auth/accountDeletedNotice';

/**
 * docs/tasks/Задача_fix_web-google-redirect-external.md — клик «Continue with
 * Google» обязан быть ПОЛНЫМ переходом браузера (`window.location.assign`), не
 * клиентской навигацией react-router (`navigate()` молча остаётся на месте на
 * чужом origin — accounts.google.com). Здесь достаточно проверить, что вызван
 * именно `window.location.assign` с `authorize_url` из ответа мока
 * (`buildAuthorizeUrl`, web/src/mocks/authGlobalDb.ts) — сам переход на реальный
 * accounts.google.com живьём проверяется на проде (см. задачу §6), в jsdom его
 * не воспроизвести.
 */
function renderWelcomePage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('en');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/welcome']}>
          <Routes>
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/login/email" element={<div data-testid="navigated-email-login" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('WelcomePage — cookie-баннер показывается один раз (отсмотр 2026-08-24)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('первый визит: баннер виден и факт показа зафиксирован; второй визит без клика — баннера нет', () => {
    const first = renderWelcomePage();
    expect(screen.getByText(/only necessary cookies/i)).toBeInTheDocument();
    expect(localStorage.getItem('porukam.cookieBannerShown')).toBe('1');
    // Явного выбора не было — действует дефолт «только необходимые», ничего не записано.
    expect(localStorage.getItem('porukam.cookieChoice')).toBeNull();

    first.unmount();
    renderWelcomePage();
    expect(screen.queryByText(/only necessary cookies/i)).not.toBeInTheDocument();
  });

  it('клик «Accept all» сохраняет явный выбор и скрывает баннер', async () => {
    const user = userEvent.setup();
    renderWelcomePage();
    await user.click(screen.getByRole('button', { name: 'Accept all' }));
    expect(localStorage.getItem('porukam.cookieChoice')).toBe('all');
    expect(screen.queryByText(/only necessary cookies/i)).not.toBeInTheDocument();
  });
});

describe('WelcomePage — переход в Google-вход', () => {
  const originalLocation = window.location;

  afterEach(() => {
    vi.restoreAllMocks();
    // jsdom не даёт спайнить window.location.assign напрямую (свойство
    // неперезаписываемое) — подменяем весь `location` на объект-обёртку с
    // мок-`assign`, поэтому восстанавливаем оригинал после теста явно.
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('клик «Continue with Google» — window.location.assign на authorize_url, НЕ клиентский роутер', async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });
    const user = userEvent.setup();
    renderWelcomePage();

    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));

    expect(assignSpy).toHaveBeenCalledTimes(1);
    const [calledUrl] = assignSpy.mock.calls[0] as [string];
    expect(calledUrl).toMatch(/^\/auth\/google\/mock\?state=/); // authorize_url мока (buildAuthorizeUrl)
    // Экран не остаётся на /welcome со свежесмонтированным внутренним роутом —
    // именно так проявлялся баг (react-router не умел уйти на чужой origin, но
    // здесь мок сам ведёт на внутренний путь, поэтому проверяем факт вызова
    // assign, а не итоговый URL страницы).
  });
});

/**
 * Уведомление «Аккаунт удалён» (ADR-169): после удаления человек оказывается на
 * экране входа — без подтверждения это выглядело бы как обычный выброс из
 * сессии. Флаг одноразовый: на следующем заходе тоста быть не должно.
 */
describe('WelcomePage — уведомление после удаления аккаунта', () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('флаг удаления показывает тост один раз и стирается', () => {
    markAccountDeleted();
    const first = renderWelcomePage();
    expect(screen.getByRole('status')).toHaveTextContent('Account deleted');
    expect(sessionStorage.getItem('porukam.accountDeleted')).toBeNull();

    first.unmount();
    renderWelcomePage();
    expect(screen.queryByText('Account deleted')).not.toBeInTheDocument();
  });

  it('без флага тоста нет', () => {
    renderWelcomePage();
    expect(screen.queryByText('Account deleted')).not.toBeInTheDocument();
  });
});

/**
 * ADR-168 — второй способ входа рядом с Google. Порядок намеренный: Google
 * остаётся главной кнопкой, почта — второстепенной, и ведёт она ВНУТРЬ
 * приложения (клиентский маршрут), а не наружу: в PWA/TWA-обёртке внешний
 * переход выбрасывал бы человека из приложения.
 */
describe('WelcomePage — вход по почте', () => {
  it('под кнопкой Google есть «Sign in with email», ведущая на /login/email', async () => {
    const user = userEvent.setup();
    renderWelcomePage();

    const google = screen.getByRole('button', { name: 'Continue with Google' });
    const email = screen.getByRole('button', { name: 'Sign in with email' });
    // Порядок в DOM = порядок чтения: главная кнопка выше второстепенной.
    expect(google.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(email);
    expect(screen.getByTestId('navigated-email-login')).toBeInTheDocument();
  });
});
