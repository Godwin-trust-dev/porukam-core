import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { NotificationsSettingsPage } from '../src/pages/settings/NotificationsSettingsPage';
import { usePushResubscribe } from '../src/features/notifications/usePushResubscribe';
import { usePushDeviceStore } from '../src/features/notifications/pushDeviceStore';
import { waitForServiceWorkerReady } from '../src/features/notifications/push';
import { useAuthStore } from '../src/features/auth/authStore';
import { server } from '../src/mocks/server';
import { pushSubscriptionEndpoints, resetPushSubscriptions } from '../src/mocks/pushHandlers';

/**
 * «Подписка не подхватывается без перелогина» (владелец 10.09: *«поменяла
 * браузер на хром, тоже сразу не работало, потом вышла из сессии в браузере, и
 * потом заработали»*).
 *
 * Две причины, обе здесь: сверка стартовала, пока service worker ещё
 * `installing`, а флаг «сверено» запирал её на всю сессию вкладки независимо от
 * исхода. Третье средство — ручная кнопка «Проверить сейчас» в статусе
 * устройства: она делает ровно то, что раньше делал перелогин.
 */
const SESSION_FLAG = 'porukam.push.ensured';
const ENDPOINT = 'https://push.example/from-sw';

function settingsResponse(patch: Record<string, unknown> = {}) {
  return {
    in_app: true,
    push: true,
    push_permission: 'granted',
    email: false,
    email_address: 'a@b.c',
    groups: { deals: true, chats: true, payments: true, deadlines: true, disputes: true },
    ...patch,
  };
}

function serverSettings(patch: Record<string, unknown> = {}): void {
  server.use(http.get('/v1/notification-settings', () => HttpResponse.json(settingsResponse(patch))));
}

function vapid(key = 'AQID'): void {
  server.use(http.get('/v1/push/config', () => HttpResponse.json({ vapid_public_key: key })));
}

function subscriptionObject(endpoint = ENDPOINT) {
  return {
    endpoint,
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

/**
 * Service worker, который становится готовым НЕ СРАЗУ, — тот самый случай:
 * `getRegistration()` до активации отдаёт `null`, а `ready` разрешается позже.
 */
function stubSlowServiceWorker({ subscribed = false }: { subscribed?: boolean } = {}) {
  let resolveReady: (reg: unknown) => void = () => undefined;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const getSubscription = vi.fn().mockResolvedValue(subscribed ? subscriptionObject() : null);
  const subscribe = vi.fn().mockResolvedValue(subscriptionObject());
  const registration = { pushManager: { getSubscription, subscribe } };
  let active = false;
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  vi.stubGlobal('PushManager', class FakePushManager {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready,
      // Пока SW не активирован, регистрации ещё нет — подписаться не у чего.
      getRegistration: vi.fn().mockImplementation(() => Promise.resolve(active ? registration : null)),
    },
  });
  return {
    subscribe,
    getSubscription,
    activate: () => {
      active = true;
      resolveReady(registration);
    },
  };
}

function Probe(): JSX.Element {
  usePushResubscribe();
  return <div data-testid="probe" />;
}

function renderWith(node: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  sessionStorage.clear();
  localStorage.clear();
  resetPushSubscriptions();
  usePushDeviceStore.setState({ lastSubscribeResult: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  sessionStorage.clear();
  localStorage.clear();
  usePushDeviceStore.setState({ lastSubscribeResult: null });
});

describe('ожидание service worker перед сверкой (10.09)', () => {
  it('без serviceWorker ожидание не виснет и отвечает «не готов»', async () => {
    expect(await waitForServiceWorkerReady(50)).toBe(false);
  });

  it('`ready` не разрешается — выходим по таймауту, а не ждём вечно (мок-контур)', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: new Promise(() => undefined), getRegistration: vi.fn().mockResolvedValue(null) },
    });
    const started = Date.now();
    expect(await waitForServiceWorkerReady(60)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('сверка не трогает подписку, пока SW не активен, и подписывается после активации', async () => {
    serverSettings();
    vapid();
    const sw = stubSlowServiceWorker();
    renderWith(<Probe />);
    await screen.findByTestId('probe');

    // Пока SW `installing`, попытки нет вовсе — раньше она приходилась ровно
    // сюда, падала и оставляла человека без уведомлений до перелогина.
    await new Promise((r) => setTimeout(r, 50));
    expect(sw.subscribe).not.toHaveBeenCalled();

    sw.activate();
    await waitFor(() => expect(sw.subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pushSubscriptionEndpoints.has(ENDPOINT)).toBe(true));
    await waitFor(() => expect(sessionStorage.getItem(SESSION_FLAG)).toBe('1'));
  });
});

describe('флаг «сверено» — только при успехе (10.09)', () => {
  it('подписка не удалась — флага нет, следующая загрузка попробует снова', async () => {
    serverSettings();
    // Пустой ключ = инсталляция без Web Push: подписка не состоится.
    vapid('');
    const sw = stubSlowServiceWorker();
    renderWith(<Probe />);
    await screen.findByTestId('probe');
    sw.activate();

    await waitFor(() =>
      expect(usePushDeviceStore.getState().lastSubscribeResult).toEqual({ ok: false, reason: 'no_key' }),
    );
    expect(sessionStorage.getItem(SESSION_FLAG)).toBeNull();
  });

  it('флаг уже стоит — сверка не повторяется (одна на сессию вкладки)', async () => {
    sessionStorage.setItem(SESSION_FLAG, '1');
    serverSettings();
    vapid();
    const sw = stubSlowServiceWorker();
    renderWith(<Probe />);
    await screen.findByTestId('probe');
    sw.activate();
    await new Promise((r) => setTimeout(r, 50));
    expect(sw.subscribe).not.toHaveBeenCalled();
  });
});

describe('«Проверить сейчас» в статусе устройства (10.09)', () => {
  it('состояние «уведомления включены» — кнопка есть и перерегистрирует подписку', async () => {
    serverSettings();
    vapid();
    const sw = stubSlowServiceWorker({ subscribed: true });
    sw.activate();
    renderWith(<NotificationsSettingsPage />);

    expect(await screen.findByText('На этом устройстве: уведомления включены')).toBeInTheDocument();
    const recheck = await screen.findByTestId('push-recheck');
    expect(recheck).toHaveTextContent('Проверить сейчас');

    await userEvent.click(recheck);
    // Подписка та же (пересоздавать нечего), но endpoint снова уходит на бэк —
    // ровно это раньше чинилось выходом из аккаунта и повторным входом.
    await waitFor(() => expect(pushSubscriptionEndpoints.has(ENDPOINT)).toBe(true));
    expect(sw.subscribe).not.toHaveBeenCalled();
  });

  it('разрешения на устройстве нет — «Проверить сейчас» не показываем (проверять нечего)', async () => {
    serverSettings({ push_permission: 'default' });
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() });
    vi.stubGlobal('PushManager', class FakePushManager {});
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({}), getRegistration: vi.fn().mockResolvedValue(null) },
    });
    renderWith(<NotificationsSettingsPage />);
    expect(await screen.findByText('На этом устройстве: разрешение не запрошено')).toBeInTheDocument();
    expect(screen.queryByTestId('push-recheck')).not.toBeInTheDocument();
  });
});
