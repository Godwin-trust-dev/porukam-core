import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { NotificationsPage } from '../src/pages/NotificationsPage';
import { NotificationsSettingsPage } from '../src/pages/settings/NotificationsSettingsPage';
import { AppSettingsPage } from '../src/pages/settings/AppSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useLogout } from '../src/features/auth/useLogout';
import { usePushDeviceStore } from '../src/features/notifications/pushDeviceStore';
import { useNativePushRegister } from '../src/features/notifications/useNativePushRegister';
import { usePushResubscribe } from '../src/features/notifications/usePushResubscribe';
import {
  getNativePushState,
  NATIVE_PUSH_STORAGE_KEY,
  type NativePushRecord,
} from '../src/features/notifications/nativePushToken';
import { deviceTokens } from '../src/mocks/deviceTokenHandlers';
import { server } from '../src/mocks/server';

/**
 * Режим обёртки с нативным пушем (ADR-176).
 *
 * Web Push здесь не просто лишний: два канала на одном телефоне дают ДВА
 * уведомления на одно событие. Поэтому тесты следят не только за тем, что
 * появилось (регистрация токена, статус «через приложение»), но и за тем, чего
 * не произошло — системный запрос разрешения и подписка браузера.
 */

const TOKEN = 'nativeTOKEN-0123456789';

function storeToken(patch: Partial<NativePushRecord> = {}): void {
  const record: NativePushRecord = {
    provider: 'rustore',
    token: TOKEN,
    appId: 'porukam.app',
    receivedAt: '2026-09-10T10:00:00.000Z',
    ...patch,
  };
  localStorage.setItem(NATIVE_PUSH_STORAGE_KEY, JSON.stringify(record));
}

function settingsResponse(patch: Record<string, unknown> = {}) {
  return {
    in_app: true,
    push: true,
    push_permission: 'default',
    email: false,
    email_address: 'a@b.c',
    groups: { deals: true, chats: true, payments: true, deadlines: true, disputes: true },
    ...patch,
  };
}

function serverSettings(patch: Record<string, unknown> = {}): void {
  server.use(http.get('/v1/notification-settings', () => HttpResponse.json(settingsResponse(patch))));
}

/** Браузер, который УМЕЕТ Web Push: именно на нём проверяется, что его не трогают. */
function stubBrowserPush({ subscribed = false }: { subscribed?: boolean } = {}) {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const subscription = subscribed
    ? {
        endpoint: 'https://push.example/abc',
        options: { applicationServerKey: null },
        toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
        unsubscribe,
      }
    : null;
  const requestPermission = vi.fn().mockResolvedValue('granted');
  const subscribe = vi.fn().mockResolvedValue({
    endpoint: 'https://push.example/new',
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(),
  });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  vi.stubGlobal('PushManager', class FakePushManager {});
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe },
      }),
    },
    configurable: true,
  });
  return { subscribe, unsubscribe, requestPermission };
}

/** Оболочка в миниатюре: те же два эффекта, что и в `ShellLayout`. */
function ShellProbe(): JSX.Element {
  useNativePushRegister();
  usePushResubscribe();
  return <div data-testid="shell" />;
}

function LogoutProbe(): JSX.Element {
  const logout = useLogout();
  return (
    <button type="button" onClick={logout} data-testid="logout">
      выход
    </button>
  );
}

function renderWith(node: JSX.Element, me: { id: string } | null = { id: 'u-1' }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (me) qc.setQueryData(['me'], { id: me.id, profiles: [], verification_level: 'none' });
  const i18n = createI18n('ru');
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={['/notifications']}>
            <Routes>
              <Route path="/notifications" element={node} />
              <Route path="*" element={<div data-testid="navigated" />} />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().setTokens({ access: 'u-1', refresh: 'r' });
  usePushDeviceStore.setState({ lastSubscribeResult: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  localStorage.clear();
  useAuthStore.getState().logout();
});

describe('регистрация нативного токена после входа (ADR-176)', () => {
  it('токен есть и человек вошёл — строка появляется на бэке, владелец записан локально', async () => {
    storeToken();
    stubBrowserPush();
    renderWith(<ShellProbe />);

    await waitFor(() => expect(deviceTokens.get(TOKEN)).toBeDefined());
    expect(deviceTokens.get(TOKEN)).toMatchObject({ provider: 'rustore', platform: 'android', owner: 'u-1' });
    await waitFor(() => expect(getNativePushState().record?.registeredFor).toBe('u-1'));
  });

  it('вход другим аккаунтом переписывает владельца токена', async () => {
    storeToken({ registeredAt: new Date().toISOString(), registeredFor: 'u-1' });
    stubBrowserPush();
    // Второй аккаунт на том же телефоне: и Bearer, и id в кэше — другие.
    useAuthStore.getState().setTokens({ access: 'u-2', refresh: 'r' });
    renderWith(<ShellProbe />, { id: 'u-2' });

    await waitFor(() => expect(deviceTokens.get(TOKEN)?.owner).toBe('u-2'));
    await waitFor(() => expect(getNativePushState().record?.registeredFor).toBe('u-2'));
  });

  it('первая регистрация снимает Web Push-подписку этого браузера — иначе два уведомления на одно событие', async () => {
    storeToken();
    const { unsubscribe } = stubBrowserPush({ subscribed: true });
    renderWith(<ShellProbe />);

    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    await waitFor(() => expect(getNativePushState().record?.webPushCleared).toBe(true));
  });

  it('без входа не регистрируем и не шумим повторами', async () => {
    storeToken();
    useAuthStore.getState().logout();
    stubBrowserPush();
    renderWith(<ShellProbe />, null);

    await screen.findByTestId('shell');
    expect(deviceTokens.has(TOKEN)).toBe(false);
  });

  it('в нативном режиме браузерная подписка не создаётся вовсе', async () => {
    storeToken();
    const { subscribe } = stubBrowserPush();
    renderWith(<ShellProbe />);

    await waitFor(() => expect(deviceTokens.has(TOKEN)).toBe(true));
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('поверхности в нативном режиме', () => {
  function renderSettings(which: 'notifications' | 'app' = 'notifications') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const i18n = createI18n('ru');
    return render(
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={i18n}>
          {which === 'notifications' ? <NotificationsSettingsPage /> : <AppSettingsPage />}
        </I18nextProvider>
      </QueryClientProvider>,
    );
  }

  it('строка под тумблером: «уведомления через приложение Porukam»', async () => {
    serverSettings({ push: true });
    storeToken();
    stubBrowserPush();
    renderSettings();

    expect(await screen.findByText('На этом устройстве: уведомления через приложение Porukam')).toBeInTheDocument();
    // Чинить нечего — кнопок «включить здесь» и «повторить» тут нет.
    expect(screen.queryByTestId('push-enable-here')).not.toBeInTheDocument();
    expect(screen.queryByTestId('push-retry')).not.toBeInTheDocument();
  });

  it('та же строка в настройках приложения', async () => {
    serverSettings({ push: true });
    storeToken();
    stubBrowserPush();
    renderSettings('app');

    expect(await screen.findByText('На этом устройстве: уведомления через приложение Porukam')).toBeInTheDocument();
  });

  it('промо-полоса в ленте не показывается — предлагать нечего', async () => {
    serverSettings({ push: false });
    storeToken();
    stubBrowserPush();
    renderWith(<NotificationsPage />);

    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    expect(screen.queryByText(/Разрешите отправлять уведомления/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Разрешите уведомления на этом устройстве/)).not.toBeInTheDocument();
  });

  it('панель ?debug=push показывает провайдера и начало токена, но не токен целиком', async () => {
    serverSettings({ push: true });
    storeToken({ registeredAt: '2026-09-10T10:05:00.000Z', lastResult: { ok: true } });
    stubBrowserPush();
    window.history.replaceState(null, '', '/settings/app?debug=push');
    renderSettings('app');

    expect(await screen.findByTestId('push-debug-nativePush.provider')).toHaveTextContent('rustore');
    expect(screen.getByTestId('push-debug-nativePush.tokenPrefix')).toHaveTextContent('nativeTO…');
    expect(screen.getByTestId('push-debug-nativePush.registeredAt')).toHaveTextContent('2026-09-10T10:05:00.000Z');
    expect(screen.getByTestId('push-debug-nativePush.lastResult')).toHaveTextContent('ok=true');
    // Токен целиком в снимок не попадает — его пересылают в мессенджер.
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });
});

describe('выход из аккаунта снимает токен с аккаунта, но не с устройства', () => {
  it('POST /device-tokens/unregister уходит, локальная запись остаётся', async () => {
    storeToken({ registeredAt: '2026-09-10T10:05:00.000Z', registeredFor: 'u-1' });
    deviceTokens.set(TOKEN, {
      id: 'dt-1',
      provider: 'rustore',
      app_id: 'porukam.app',
      platform: 'android',
      created_at: '2026-09-10T10:05:00.000Z',
      owner: 'u-1',
    });
    renderWith(<LogoutProbe />);

    screen.getByTestId('logout').click();

    await waitFor(() => expect(deviceTokens.has(TOKEN)).toBe(false));
    // Токен принадлежит устройству: следующий вход зарегистрирует его заново.
    expect(getNativePushState().record).toMatchObject({ token: TOKEN });
  });
});
