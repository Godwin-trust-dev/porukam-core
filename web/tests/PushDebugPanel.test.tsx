import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { AppSettingsPage } from '../src/pages/settings/AppSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { usePushDeviceStore } from '../src/features/notifications/pushDeviceStore';

/**
 * Панель диагностики Web Push (жалоба владельца 10.09: бэк пишет `POST
 * /v1/push-subscriptions -> 201`, а `Notification.permission` в том же браузере
 * читается как `default`).
 *
 * Два свойства держатся тестом. Первое — панель невидима без `?debug=push`: это
 * техническая распечатка с userAgent и хостом push-сервиса, и на обычной странице
 * настроек ей делать нечего. Второе — она показывает то, что сказало УСТРОЙСТВО, а
 * не то, что мы про него думаем: значение `Notification.permission` и хост endpoint'а
 * идут в снимок как есть.
 */

const ENDPOINT_HOST = 'fcm.googleapis.com';

function fakeSubscription() {
  return {
    endpoint: `https://${ENDPOINT_HOST}/fcm/send/abc`,
    options: { applicationServerKey: null },
    expirationTime: null,
    toJSON: () => ({ endpoint: `https://${ENDPOINT_HOST}/fcm/send/abc`, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function stubDevice(permission: 'default' | 'granted' | 'denied', subscribed: boolean) {
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn() });
  vi.stubGlobal('PushManager', class FakePushManager {});
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      controller: null,
      getRegistration: vi.fn().mockResolvedValue({
        scope: 'https://porukam.app/',
        active: { state: 'activated' },
        installing: null,
        waiting: null,
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscribed ? fakeSubscription() : null),
          permissionState: vi.fn().mockResolvedValue(permission === 'default' ? 'prompt' : permission),
        },
      }),
    },
    configurable: true,
  });
}

function renderPage(search: string) {
  window.history.replaceState({}, '', `/settings/app${search}`);
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

describe('панель диагностики push — только по ?debug=push (разбор прода 10.09)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    usePushDeviceStore.setState({ lastSubscribeResult: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    usePushDeviceStore.setState({ lastSubscribeResult: null });
    window.history.replaceState({}, '', '/');
  });

  it('без параметра в адресе панели нет', async () => {
    stubDevice('granted', true);
    renderPage('');
    // Ждём саму страницу, иначе «нет панели» доказывалось бы пустым первым кадром.
    await screen.findByText('Версия приложения');
    expect(screen.queryByTestId('push-debug-panel')).not.toBeInTheDocument();
  });

  it('с ?debug=push показывает разрешение устройства и хост endpoint как есть', async () => {
    stubDevice('granted', true);
    renderPage('?debug=push');

    expect(await screen.findByTestId('push-debug-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('push-debug-Notification.permission')).toHaveTextContent('granted');
    expect(await screen.findByTestId('push-debug-subscription.endpointHost')).toHaveTextContent(ENDPOINT_HOST);
    expect(screen.getByTestId('push-debug-subscription')).toHaveTextContent('yes');
  });

  it('разрешения нет и подписки нет — обе строки честно говорят об этом', async () => {
    stubDevice('default', false);
    renderPage('?debug=push');

    expect(await screen.findByTestId('push-debug-Notification.permission')).toHaveTextContent('default');
    expect(await screen.findByTestId('push-debug-subscription')).toHaveTextContent('no');
    expect(screen.queryByTestId('push-debug-subscription.endpointHost')).not.toBeInTheDocument();
  });
});
