import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  ensureBrowserPushSubscription,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  urlBase64ToUint8Array,
} from '../src/features/notifications/push';
import { useAuthStore } from '../src/features/auth/authStore';
import { server } from '../src/mocks/server';
import { pushSubscriptionEndpoints, resetPushSubscriptions } from '../src/mocks/pushHandlers';

/**
 * Web Push подписка фронта (ADR-110): ключ с бэка → pushManager.subscribe →
 * регистрация endpoint; выключение тумблера — отписка. Тумблер настроек
 * по-прежнему не зависит от исхода, но сам исход больше не `boolean`:
 * с ADR-175 у отказа есть ПРИЧИНА — иначе «разрешение выдано, подписок ноль»
 * (прод 10.09) неотличимо от «человек ничего не разрешал».
 */

const ENDPOINT = 'https://push.example.com/send/xyz';

function mockServiceWorker(pushManager: unknown): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: () => Promise.resolve({ pushManager }) },
  });
}

describe('Web Push подписка', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    resetPushSubscriptions();
  });

  afterEach(() => {
    // jsdom по умолчанию без serviceWorker — возвращаем как было.
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it('urlBase64ToUint8Array: base64url → байты', () => {
    // 'AQID' = [1, 2, 3]; '-_' — url-safe алфавит.
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });

  it('без serviceWorker — no_sw (мок-контур/jsdom)', async () => {
    expect(await subscribeBrowserPush()).toEqual({ ok: false, reason: 'no_sw' });
  });

  it('пустой VAPID-ключ с бэка — подписки нет (не настроено на инсталляции)', async () => {
    const subscribe = vi.fn();
    mockServiceWorker({ subscribe });
    expect(await subscribeBrowserPush()).toEqual({ ok: false, reason: 'no_key' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('полный путь: ключ → subscribe → POST /push-subscriptions', async () => {
    server.use(
      http.get('/v1/push/config', () => HttpResponse.json({ vapid_public_key: 'AQID' })),
    );
    const subscription = {
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    };
    const subscribe = vi.fn().mockResolvedValue(subscription);
    mockServiceWorker({ subscribe });

    expect(await subscribeBrowserPush()).toEqual({ ok: true });
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(pushSubscriptionEndpoints.has(ENDPOINT)).toBe(true);
  });

  it('отписка: unsubscribe браузера + POST /push-subscriptions/unsubscribe', async () => {
    pushSubscriptionEndpoints.add(ENDPOINT);
    const browserSubscription = {
      endpoint: ENDPOINT,
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    mockServiceWorker({ getSubscription: () => Promise.resolve(browserSubscription) });

    await unsubscribeBrowserPush();
    expect(browserSubscription.unsubscribe).toHaveBeenCalled();
    expect(pushSubscriptionEndpoints.has(ENDPOINT)).toBe(false);
  });
});

/**
 * Сверка подписки при входе (отсмотр 2026-08-27: тумблер включён, подписок в БД ноль).
 * Без системного запроса: только при уже выданном разрешении.
 */
describe('ensureBrowserPushSubscription', () => {
  function mockPermission(permission: 'granted' | 'denied' | 'default'): void {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission },
    });
  }

  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    resetPushSubscriptions();
    server.use(
      http.get('/v1/push/config', () => HttpResponse.json({ vapid_public_key: 'AQID' })),
    );
  });

  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    delete (window as { Notification?: unknown }).Notification;
  });

  it('без выданного разрешения — ничего не делает (системный запрос не показываем)', async () => {
    mockPermission('default');
    const subscribe = vi.fn();
    mockServiceWorker({ subscribe, getSubscription: () => Promise.resolve(null) });
    expect(await ensureBrowserPushSubscription()).toEqual({ ok: false, reason: 'no_permission' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('подписки нет → подписывает под текущим ключом и регистрирует endpoint', async () => {
    mockPermission('granted');
    const subscription = {
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    };
    const subscribe = vi.fn().mockResolvedValue(subscription);
    mockServiceWorker({ subscribe, getSubscription: () => Promise.resolve(null) });
    expect(await ensureBrowserPushSubscription()).toEqual({ ok: true });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(pushSubscriptionEndpoints.has(ENDPOINT)).toBe(true);
  });

  it('подписка есть под тем же ключом → без subscribe, только перерегистрация на бэке', async () => {
    mockPermission('granted');
    const existing = {
      options: { applicationServerKey: urlBase64ToUint8Array('AQID').buffer },
      unsubscribe: vi.fn(),
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    };
    const subscribe = vi.fn();
    mockServiceWorker({ subscribe, getSubscription: () => Promise.resolve(existing) });
    expect(await ensureBrowserPushSubscription()).toEqual({ ok: true });
    expect(subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(pushSubscriptionEndpoints.has(ENDPOINT)).toBe(true);
  });

  it('подписка под другим ключом (VAPID сменили) → отписка и новая подписка', async () => {
    mockPermission('granted');
    const stale = {
      options: { applicationServerKey: urlBase64ToUint8Array('BAUG').buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
      toJSON: () => ({ endpoint: 'https://push.example.com/old', keys: { p256dh: 'p', auth: 'a' } }),
    };
    const fresh = {
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    };
    const subscribe = vi.fn().mockResolvedValue(fresh);
    mockServiceWorker({ subscribe, getSubscription: () => Promise.resolve(stale) });
    expect(await ensureBrowserPushSubscription()).toEqual({ ok: true });
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(pushSubscriptionEndpoints.has(ENDPOINT)).toBe(true);
  });
});
