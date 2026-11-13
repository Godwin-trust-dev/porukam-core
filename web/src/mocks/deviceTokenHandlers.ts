import { http, HttpResponse } from 'msw';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

const PROVIDERS = new Set(['rustore', 'fcm', 'hms']);

export interface MockDeviceToken {
  id: string;
  provider: string;
  app_id: string;
  platform: string;
  created_at: string;
  /** Владелец токена в моке — по нему тесты проверяют перезапись при смене аккаунта. */
  owner: string;
}

/** Зарегистрированные токены устройств — состояние мока и предмет ассертов в тестах. */
export const deviceTokens = new Map<string, MockDeviceToken>();

export function resetDeviceTokens(): void {
  deviceTokens.clear();
}

/** Владельца бэк берёт ИЗ ТОКЕНА доступа; в моке его роль играет сам Bearer. */
function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

/**
 * Нативные токены устройств (ADR-176) — зеркало контракта бэкенда:
 *
 * - `POST /v1/device-tokens` — 201 и идемпотентность ПО ТОКЕНУ: повтор той же
 *   строки не плодит записей, а вход другим аккаунтом переписывает владельца
 *   (токен принадлежит устройству, как endpoint у Web Push);
 * - `POST /v1/device-tokens/unregister` — 204 всегда, в том числе для чужого и
 *   вовсе неизвестного токена: выход из аккаунта не должен ничего сообщать о
 *   том, существует ли такая запись.
 */
export const deviceTokenHandlers = [
  http.post(`${BASE}/device-tokens`, async ({ request }) => {
    const owner = bearer(request);
    if (!owner) return problem(401, 'unauthorized', 'Нужен вход.');
    const body = (await request.json()) as { provider?: string; token?: string; app_id?: string; platform?: string };
    if (!body.token || !body.provider || !PROVIDERS.has(body.provider)) {
      return problem(400, 'invalid_request', 'provider и token обязательны');
    }
    const existing = deviceTokens.get(body.token);
    const row: MockDeviceToken = {
      id: existing?.id ?? `dt-${deviceTokens.size + 1}`,
      provider: body.provider,
      app_id: body.app_id ?? '',
      platform: body.platform ?? 'android',
      created_at: existing?.created_at ?? new Date().toISOString(),
      owner,
    };
    deviceTokens.set(body.token, row);
    return HttpResponse.json(row, { status: 201 });
  }),
  http.post(`${BASE}/device-tokens/unregister`, async ({ request }) => {
    if (!bearer(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const body = (await request.json()) as { token?: string };
    if (body.token) deviceTokens.delete(body.token);
    return new HttpResponse(null, { status: 204 });
  }),
];
