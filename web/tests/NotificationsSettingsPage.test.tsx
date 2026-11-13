import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { NotificationsSettingsPage } from '../src/pages/settings/NotificationsSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { debugSetEmailAddress, debugSetPushPermission, resetNotifications } from '../src/mocks/notificationsDb';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <NotificationsSettingsPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('NotificationsSettingsPage (DEV-14) — критерии приёмки §10/§11', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    resetNotifications();
  });

  it('лента в приложении — «Всегда», без тумблера (не отключить)', async () => {
    renderPage();
    const label = await screen.findByText('Лента в приложении');
    const row = label.closest('div')!.parentElement!;
    expect(within(row).getByText('Всегда')).toBeInTheDocument();
    expect(within(row).queryByRole('switch')).not.toBeInTheDocument();
  });

  /* ADR-175: «отклонено» — свойство УСТРОЙСТВА, а не аккаунта, поэтому тест
     стабит `Notification.permission`; серверный `push_permission` остаётся
     фолбэком для устройств, которые о себе ничего сказать не могут. */
  it('push denied устройством → тумблер неактивен + честная подсказка', async () => {
    debugSetPushPermission('denied');
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() });
    vi.stubGlobal('PushManager', class FakePushManager {});
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistration: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    renderPage();
    await screen.findByText('Уведомления выключены в настройках устройства');
    await screen.findByText('На этом устройстве: отклонено в настройках устройства');
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push-уведомления' })).toBeDisabled());
  });

  it('включение push → системный запрос → granted → тумблер вкл', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    });
    renderPage();
    const pushSwitch = await screen.findByRole('switch', { name: 'Push-уведомления' });
    await userEvent.click(pushSwitch);

    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Разрешить' }));

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push-уведомления' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('группы дублирования: снять «Споры» — сохраняется в моке', async () => {
    renderPage();
    const disputesSwitch = await screen.findByRole('switch', { name: 'Споры' });
    expect(disputesSwitch).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(disputesSwitch);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Споры' })).toHaveAttribute('aria-checked', 'false'));
  });

  it('email: подпись подставляет адрес аккаунта', async () => {
    renderPage();
    expect(await screen.findByText(/Дублировать уведомления на/)).toBeInTheDocument();
  });

  it('email: пустой адрес (OTP-пользователь) — честная подсказка вместо оборванной фразы', async () => {
    debugSetEmailAddress('');
    renderPage();
    expect(await screen.findByText('Адрес электронной почты не указан')).toBeInTheDocument();
    expect(screen.queryByText(/Дублировать уведомления на/)).not.toBeInTheDocument();
  });

  it('iOS вне standalone — включение push открывает инструкцию установки, не системный запрос (DEV-15 §5)', async () => {
    const originalUserAgent = window.navigator.userAgent;
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });

    renderPage();
    await screen.findByText('Сначала добавьте приложение на экран «Домой» — после этого можно включить уведомления');
    const pushSwitch = screen.getByRole('switch', { name: 'Push-уведомления' });
    await userEvent.click(pushSwitch);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Установка на экран «Домой»');

    Object.defineProperty(window.navigator, 'userAgent', { value: originalUserAgent, configurable: true });
  });
});
