import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api/client';
import { ApiError } from '../src/errors';

/** Тихое продление сессии по 401 (отсмотр прода 2026-08-18 №9):
 * access живёт 15 минут — клиент обязан сам обновлять пару и повторять
 * запрос, а не отдавать страницам тупиковый authentication_required. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PROBLEM_401 = { status: 401, code: 'authentication_required', title: 'Нужен вход' };

describe('ApiClient — тихий refresh по 401', () => {
  it('обновляет пару и повторяет исходный запрос', async () => {
    let access = 'stale';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/token/refresh')) {
        expect(JSON.parse(String(init?.body))).toEqual({ refresh: 'refresh-1' });
        return jsonResponse(200, { access: 'fresh', refresh: 'refresh-2' });
      }
      const auth = (init?.headers as Record<string, string>)['Authorization'];
      return auth === 'Bearer fresh'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, PROBLEM_401);
    });
    const onTokensRefreshed = vi.fn((pair: { access: string }) => {
      access = pair.access;
    });

    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => access,
      getRefreshToken: () => 'refresh-1',
      onTokensRefreshed,
    });

    await expect(client.request('/users/me')).resolves.toEqual({ ok: true });
    expect(onTokensRefreshed).toHaveBeenCalledWith({ access: 'fresh', refresh: 'refresh-2' });
    // 401 → refresh → повтор: ровно три вызова fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refresh отклонён — onAuthExpired и исходная 401-ошибка', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/auth/token/refresh')
        ? jsonResponse(401, { status: 401, code: 'refresh_token_invalid', title: 'нет' })
        : jsonResponse(401, PROBLEM_401),
    );
    const onAuthExpired = vi.fn();

    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => 'stale',
      getRefreshToken: () => 'refresh-1',
      onAuthExpired,
    });

    const err = await client.request('/users/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('authentication_required');
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it('на /auth/token/refresh НЕ уходит Authorization (ADR-119: протухший Bearer ронял refresh)', async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string>)['Authorization'];
      if (url.endsWith('/auth/token/refresh')) {
        seen.push(auth);
        return jsonResponse(200, { access: 'fresh', refresh: 'refresh-2' });
      }
      return auth === 'Bearer fresh' ? jsonResponse(200, { ok: true }) : jsonResponse(401, PROBLEM_401);
    });
    let access = 'stale';
    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => access,
      getRefreshToken: () => 'refresh-1',
      onTokensRefreshed: (pair) => {
        access = pair.access;
      },
    });

    await expect(client.request('/users/me')).resolves.toEqual({ ok: true });
    expect(seen).toEqual([undefined]);
  });

  it('401 на refresh с ЛЮБЫМ кодом (старый бэк: authentication_required) — приговор, logout (ADR-119)', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/auth/token/refresh')
        ? jsonResponse(401, PROBLEM_401)
        : jsonResponse(401, PROBLEM_401),
    );
    const onAuthExpired = vi.fn();
    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => 'stale',
      getRefreshToken: () => 'refresh-1',
      onAuthExpired,
    });

    await expect(client.request('/users/me')).rejects.toBeInstanceOf(ApiError);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it('4xx на refresh без refresh_token_invalid (Cloudflare 403) — НЕ logout (ADR-108)', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/auth/token/refresh')
        ? new Response('<html>challenge</html>', { status: 403, headers: { 'Content-Type': 'text/html' } })
        : jsonResponse(401, PROBLEM_401),
    );
    const onAuthExpired = vi.fn();

    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => 'stale',
      getRefreshToken: () => 'refresh-1',
      onAuthExpired,
    });

    const err = await client.request('/users/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it('параллельные 401 ждут ОДИН refresh (single-flight)', async () => {
    let access = 'stale';
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/token/refresh')) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse(200, { access: 'fresh', refresh: 'refresh-2' });
      }
      const auth = (init?.headers as Record<string, string>)['Authorization'];
      return auth === 'Bearer fresh'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, PROBLEM_401);
    });

    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => access,
      getRefreshToken: () => 'refresh-1',
      onTokensRefreshed: (pair) => {
        access = pair.access;
      },
    });

    await expect(
      Promise.all([client.request('/users/me'), client.request('/contracts')]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCalls).toBe(1);
  });

  it('401 от самого /auth/* НЕ уводит в refresh (вход с неверным кодом)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { status: 401, code: 'otp_invalid_code', title: 'нет' }),
    );
    const onAuthExpired = vi.fn();

    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getRefreshToken: () => 'refresh-1',
      onAuthExpired,
    });

    await expect(client.request('/auth/otp/verify', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it('без getRefreshToken поведение прежнее — 401 пробрасывается как есть', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, PROBLEM_401));
    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.request('/users/me')).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('refresh НЕДОСТУПЕН (5xx/сеть) — БЕЗ onAuthExpired, исходная ошибка наружу', async () => {
    // №8/№9 отсмотров: холодный прод отдаёт таймаут/502 на refresh — пара может
    // быть жива, разлогин выбрасывал бы человека на /welcome посреди мастера
    // (отсмотр 2026-08-19, шаг «Этапы»).
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/auth/token/refresh')
        ? jsonResponse(502, { status: 502, title: 'Bad Gateway' })
        : jsonResponse(401, PROBLEM_401),
    );
    const onAuthExpired = vi.fn();

    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => 'stale',
      getRefreshToken: () => 'refresh-1',
      onAuthExpired,
    });

    const err = await client.request('/users/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it('refresh упал сетевой ошибкой — тоже без разлогина', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/token/refresh')) throw new TypeError('Failed to fetch');
      return jsonResponse(401, PROBLEM_401);
    });
    const onAuthExpired = vi.fn();

    const client = new ApiClient({
      baseUrl: '/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: () => 'stale',
      getRefreshToken: () => 'refresh-1',
      onAuthExpired,
    });

    const err = await client.request('/users/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(onAuthExpired).not.toHaveBeenCalled();
  });
});

/** Повторяемый query-параметр (план 11.09 §6, ADR-184/185: `sphere=` в
 * каталожном поиске) — массив в `query` должен уйти НЕСКОЛЬКИМИ парами
 * `append`, не CSV-строкой одним `set`, иначе `getlist()` бэка их не увидит. */
describe('ApiClient — query с массивом', () => {
  it('каждый элемент массива — своя пара key=value', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse(200, { ok: true });
    });
    const client = new ApiClient({ baseUrl: '/v1', fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.request('/dashboard/search', { query: { sphere: ['repair', 'beauty'], country: 'KZ' } });

    const url = new URL(capturedUrl);
    expect(url.searchParams.getAll('sphere')).toEqual(['repair', 'beauty']);
    expect(url.searchParams.get('country')).toBe('KZ');
  });
});
