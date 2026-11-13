import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../src/mocks/server';
import {
  ensureBrowserPushSubscription,
  getDevicePushState,
  subscribeBrowserPush,
  type DevicePushState,
} from '../src/features/notifications/push';
import { devicePushStatus, failureReasonKey } from '../src/features/notifications/pushDeviceStatus';
import { useAuthStore } from '../src/features/auth/authStore';

/**
 * Состояние push на ЭТОМ устройстве и ЧИТАЕМЫЕ причины сбоя (ADR-175).
 *
 * Разбор прода 10.09: у пяти активных пользователей из семи серверный
 * `push=true`, `push_permission='default'` и ноль подписок, у одного —
 * `granted` и тоже ноль. Первое означало «разрешение никто не спрашивал»,
 * второе — «подписка не создалась», и различить их было нечем: обе функции
 * возвращали `false` и глотали исключение.
 */

const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFZZoJvvJI';

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe: () => Promise<boolean>;
}

function fakeSubscription(overrides: Partial<FakeSubscription> = {}): FakeSubscription {
  return {
    endpoint: 'https://push.example/abc',
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

interface StubOptions {
  permission?: 'default' | 'granted' | 'denied';
  /** `null` — SW зарегистрирован, но подписки нет. */
  subscription?: FakeSubscription | null;
  subscribeResult?: FakeSubscription | Error;
  /** SW не зарегистрирован вовсе (первые секунды после загрузки). */
  noRegistration?: boolean;
  /** Регистрация без `pushManager` (сборка без push-сервиса). */
  noPushManager?: boolean;
  /** Устройство не умеет Web Push (вкладка iOS-Safari). */
  unsupported?: boolean;
}

function stubDevice(options: StubOptions = {}) {
  const { permission = 'granted', subscription = null, noRegistration, noPushManager, unsupported } = options;
  if (!unsupported) {
    vi.stubGlobal('Notification', { permission, requestPermission: vi.fn().mockResolvedValue(permission) });
    vi.stubGlobal('PushManager', class FakePushManager {});
  }
  const subscribe = vi.fn().mockImplementation(() => {
    const result = options.subscribeResult ?? subscription ?? fakeSubscription();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const pushManager = { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe };
  const registration = noPushManager ? {} : { pushManager };
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration: vi.fn().mockResolvedValue(noRegistration ? undefined : registration) },
    configurable: true,
  });
  return { pushManager, subscribe };
}

function vapidConfig(key: string = VAPID): void {
  server.use(http.get('/v1/push/config', () => HttpResponse.json({ vapid_public_key: key })));
}

describe('getDevicePushState — правда об ЭТОМ устройстве (ADR-175)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('нет Notification/PushManager (вкладка iOS-Safari) — unsupported, спрашивать нечего', async () => {
    await expect(getDevicePushState()).resolves.toEqual({ permission: 'unsupported', subscribed: false, native: false });
  });

  it('разрешение не запрашивали — default без подписки', async () => {
    stubDevice({ permission: 'default' });
    await expect(getDevicePushState()).resolves.toEqual({ permission: 'default', subscribed: false, native: false });
  });

  it('разрешение выдано и подписка жива — granted + subscribed', async () => {
    stubDevice({ permission: 'granted', subscription: fakeSubscription() });
    await expect(getDevicePushState()).resolves.toEqual({ permission: 'granted', subscribed: true, native: false });
  });

  it('разрешение выдано, а подписки нет — granted без подписки (тихая поломка прода 10.09)', async () => {
    stubDevice({ permission: 'granted', subscription: null });
    await expect(getDevicePushState()).resolves.toEqual({ permission: 'granted', subscribed: false, native: false });
  });

  it('отказ на устройстве — denied', async () => {
    stubDevice({ permission: 'denied' });
    await expect(getDevicePushState()).resolves.toEqual({ permission: 'denied', subscribed: false, native: false });
  });

  it('SW ещё не зарегистрирован — поддержка есть, подписки нет (не unsupported)', async () => {
    stubDevice({ permission: 'granted', noRegistration: true });
    await expect(getDevicePushState()).resolves.toEqual({ permission: 'granted', subscribed: false, native: false });
  });
});

describe('devicePushStatus — состояние одним словом', () => {
  const cases: Array<[DevicePushState | null, string]> = [
    [null, 'loading'],
    [{ permission: 'unsupported', subscribed: false, native: false }, 'unsupported'],
    [{ permission: 'denied', subscribed: false, native: false }, 'denied'],
    [{ permission: 'default', subscribed: false, native: false }, 'not_asked'],
    [{ permission: 'granted', subscribed: true, native: false }, 'enabled'],
    [{ permission: 'granted', subscribed: false, native: false }, 'failed'],
    // ADR-176: нативный канал старше браузерного — ни отсутствие разрешения,
    // ни `unsupported` (Huawei без сервисов Google) уже не значат «не дойдёт».
    [{ permission: 'default', subscribed: false, native: true }, 'native'],
    [{ permission: 'unsupported', subscribed: false, native: true }, 'native'],
    [{ permission: 'denied', subscribed: false, native: true }, 'native'],
  ];
  it.each(cases)('%o → %s', (state, expected) => {
    expect(devicePushStatus(state)).toBe(expected);
  });

  it('причина без попытки — «устройство отказало», а не молчание', () => {
    expect(failureReasonKey(null)).toBe('notifications.pushDeviceReasonSubscribeFailed');
    expect(failureReasonKey({ ok: false, reason: 'no_key' })).toBe('notifications.pushDeviceReasonNoKey');
  });
});

describe('subscribeBrowserPush / ensureBrowserPushSubscription — причина вместо false', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('SW не зарегистрирован — no_sw', async () => {
    stubDevice({ noRegistration: true });
    await expect(subscribeBrowserPush()).resolves.toEqual({ ok: false, reason: 'no_sw' });
  });

  it('регистрация без pushManager — no_push_manager', async () => {
    stubDevice({ noPushManager: true });
    await expect(subscribeBrowserPush()).resolves.toEqual({ ok: false, reason: 'no_push_manager' });
  });

  it('инсталляция без ключа — no_key (мок отдаёт пустой vapid_public_key)', async () => {
    stubDevice({ permission: 'granted' });
    await expect(subscribeBrowserPush()).resolves.toEqual({ ok: false, reason: 'no_key' });
  });

  it('устройство отказало — subscribe_failed с текстом исключения, обрезанным до 200', async () => {
    vapidConfig();
    stubDevice({ permission: 'granted', subscribeResult: new Error('x'.repeat(500)) });
    const result = await subscribeBrowserPush();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('subscribe_failed');
    expect(result.message).toHaveLength(200);
    expect(result.message?.startsWith('Error: xxx')).toBe(true);
  });

  it('бэк не принял endpoint — register_failed, а не «просто не получилось»', async () => {
    vapidConfig();
    server.use(
      http.post('/v1/push-subscriptions', () =>
        HttpResponse.json({ status: 500, code: 'internal_error', title: 'internal_error' }, { status: 500 }),
      ),
    );
    stubDevice({ permission: 'granted' });
    const result = await subscribeBrowserPush();
    expect(result.reason).toBe('register_failed');
    expect(result.message).toBeTruthy();
  });

  it('всё сложилось — ok без причины', async () => {
    vapidConfig();
    stubDevice({ permission: 'granted' });
    await expect(subscribeBrowserPush()).resolves.toEqual({ ok: true });
  });

  it('сверка без разрешения — no_permission (системный диалог отсюда не показывается)', async () => {
    stubDevice({ permission: 'default' });
    await expect(ensureBrowserPushSubscription()).resolves.toEqual({ ok: false, reason: 'no_permission' });
  });

  it('сверка при granted без подписки — подписывает и отдаёт ok', async () => {
    vapidConfig();
    const { subscribe } = stubDevice({ permission: 'granted', subscription: null });
    await expect(ensureBrowserPushSubscription()).resolves.toEqual({ ok: true });
    expect(subscribe).toHaveBeenCalled();
  });

  it('сверка при пустом ключе на инсталляции — no_key (прод без ключа, 27.08)', async () => {
    stubDevice({ permission: 'granted' });
    await expect(ensureBrowserPushSubscription()).resolves.toEqual({ ok: false, reason: 'no_key' });
  });
});
