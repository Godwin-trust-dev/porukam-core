import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ApiClient, ApiError } from '@porukam/core';
import { server } from '../src/mocks/server';
import { AUTH_STORAGE_KEY, useAuthStore } from '../src/features/auth/authStore';

/**
 * ADR-107 — сессия не рвётся ротацией refresh из соседней вкладки («регулярно выбрасывает на авторизацию», отсмотр 2026-08-21).
 */

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().logout();
});
afterEach(() => {
  localStorage.clear();
  useAuthStore.getState().logout();
});

describe('authStore — синхронизация вкладок (ADR-107; базовый persist — authStore.persist.test.ts)', () => {
  it('событие storage из соседней вкладки подхватывает новый refresh', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'old' });
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify(
        { state: { access: 'a2', refresh: 'rotated-elsewhere', isAuthenticated: true, loginMethod: 'otp' }, version: 0 },
      ),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY }));
    await vi.waitFor(() => expect(useAuthStore.getState().refresh).toBe('rotated-elsewhere'));
  });
});

describe('ApiClient — refresh при ротации из другой вкладки', () => {
  it('старый refresh отвергнут, но в хранилище уже новый → повтор с новым, без logout', async () => {
    let refreshCalls: string[] = [];
    server.use(
      http.post('/v1/auth/token/refresh', async ({ request }) => {
        const { refresh } = (await request.json()) as { refresh: string };
        refreshCalls.push(refresh);
        if (refresh === 'stale') {
          // Параллельно «другая вкладка» уже положила новый токен.
          current = 'fresh';
          return HttpResponse.json({ status: 401, code: 'refresh_token_invalid', detail: 'blacklisted' }, { status: 401 });
        }
        return HttpResponse.json({ access: 'acc-2', refresh: 'ref-2' });
      }),
      http.get('/v1/ping', ({ request }) =>
        request.headers.get('Authorization') === 'Bearer acc-2'
          ? HttpResponse.json({ ok: true })
          : HttpResponse.json({ status: 401, code: 'unauthorized', detail: '' }, { status: 401 }),
      ),
    );
    let current: string | null = 'stale';
    let access: string | null = 'expired';
    const expired = vi.fn();
    const client = new ApiClient({
      baseUrl: '/v1',
      getAccessToken: () => access,
      getRefreshToken: () => current,
      onTokensRefreshed: (t) => {
        access = t.access;
        current = t.refresh;
      },
      onAuthExpired: expired,
    });

    const res = await client.request<{ ok: boolean }>('/ping');
    expect(res.ok).toBe(true);
    expect(refreshCalls).toEqual(['stale', 'fresh']);
    expect(expired).not.toHaveBeenCalled();
    refreshCalls = [];
  });

  it('refresh отвергнут и в хранилище тот же токен → сессия мертва, onAuthExpired', async () => {
    server.use(
      http.post('/v1/auth/token/refresh', () =>
        HttpResponse.json({ status: 401, code: 'refresh_token_invalid', detail: 'expired' }, { status: 401 }),
      ),
      http.get('/v1/ping', () => HttpResponse.json({ status: 401, code: 'unauthorized', detail: '' }, { status: 401 })),
    );
    const expired = vi.fn();
    const client = new ApiClient({
      baseUrl: '/v1',
      getAccessToken: () => 'expired',
      getRefreshToken: () => 'dead',
      onAuthExpired: expired,
    });
    await expect(client.request('/ping')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
