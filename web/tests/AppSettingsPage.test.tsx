import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { AppSettingsPage } from '../src/pages/settings/AppSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { usePwaStore } from '../src/features/pwa/pwaStore';
import { resetNotifications } from '../src/mocks/notificationsDb';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <AppSettingsPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

// jsdom не реализует matchMedia — своя заглушка, не .bind() несуществующего оригинала.
const originalMatchMedia = window.matchMedia;
const originalUserAgent = window.navigator.userAgent;

function setStandalone(matches: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('display-mode: standalone') ? matches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }) as MediaQueryList) as typeof window.matchMedia;
}

describe('AppSettingsPage (DEV-15 §6) — критерии приёмки §10', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNotifications();
    // `installPrompt` живёт в сторе (перехват до рендера) — без сброса пойманный в одном
    // тесте промпт утёк бы в следующий, где проверяется поведение БЕЗ промпта.
    usePwaStore.setState({ needRefresh: false, offlineReady: false, updateSW: null, installPrompt: null });
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(window.navigator, 'userAgent', { value: originalUserAgent, configurable: true });
  });

  it('не установлено, промпт пойман — «Установить приложение» зовёт системный промпт', async () => {
    let prompted = false;
    renderPage();
    const row = await screen.findByRole('button', { name: /Установить приложение/ });

    act(() => {
      const evt = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt?: () => Promise<void>;
        userChoice?: Promise<{ outcome: string; platform: string }>;
      };
      evt.prompt = () => ((prompted = true), Promise.resolve());
      evt.userChoice = Promise.resolve({ outcome: 'accepted', platform: '' });
      window.dispatchEvent(evt);
    });
    await userEvent.click(row);

    expect(prompted).toBe(true);
    // Ручная инструкция не нужна — системный промпт уже показан.
    expect(screen.queryByText('Как установить приложение')).not.toBeInTheDocument();
  });

  it('промпта нет (Android без beforeinstallprompt) — вместо молчания инструкция по меню браузера', async () => {
    // Раньше клик здесь был тихим no-op: `promptInstall()` выходил на `if (!deferredPrompt) return`,
    // и человек считал, что установка сломана (жалоба владельца 05.09).
    renderPage();
    const row = await screen.findByRole('button', { name: /Установить приложение/ });
    expect(screen.queryByText('Как установить приложение')).not.toBeInTheDocument();

    await userEvent.click(row);

    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveTextContent('Как установить приложение');
    expect(sheet).toHaveTextContent(/Samsung Internet/);
  });

  it('standalone — «Установлено», кнопки установки нет', async () => {
    setStandalone(true);
    renderPage();
    await screen.findByText('Установлено');
    expect(screen.queryByRole('button', { name: /Установить приложение/ })).not.toBeInTheDocument();
  });

  it('версия — «актуальная» по умолчанию, «доступно обновление» при needRefresh (§4/§6)', async () => {
    renderPage();
    await screen.findByText('Актуальная версия');
    expect(screen.queryByText('Доступно обновление')).not.toBeInTheDocument();

    act(() => usePwaStore.getState().setNeedRefresh(true));
    await waitFor(() => expect(screen.getByText('Доступно обновление')).toBeInTheDocument());
  });

  it('push на iOS вне standalone — честная подсказка вместо системного запроса (§5)', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });
    renderPage();

    const pushSwitch = await screen.findByRole('switch', { name: 'Push-уведомления' });
    await screen.findByText('Сначала добавьте приложение на экран «Домой» — после этого можно включить уведомления');

    await userEvent.click(pushSwitch);
    await screen.findByRole('dialog');
    expect(screen.getByRole('dialog')).toHaveTextContent('Установка на экран «Домой»');
  });
});
