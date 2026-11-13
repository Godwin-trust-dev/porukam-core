import { http, HttpResponse } from 'msw';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/** Endpoint'ы зарегистрированных подписок — для ассертов в тестах. */
export const pushSubscriptionEndpoints = new Set<string>();

export function resetPushSubscriptions(): void {
  pushSubscriptionEndpoints.clear();
}

/**
 * Web Push (ADR-110). `vapid_public_key` в моке ПУСТОЙ — фронт трактует это
 * как «инсталляция без Web Push» и молча пропускает `PushManager.subscribe`
 * (в jsdom/мок-контуре pushManager и не существует); эндпоинты подписки при
 * этом зеркалятся честно — их дергают юнит-тесты `push.ts`.
 */
export const pushHandlers = [
  http.get(`${BASE}/push/config`, ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    return HttpResponse.json({ vapid_public_key: '' });
  }),
  http.post(`${BASE}/push-subscriptions`, async ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const body = (await request.json()) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return problem(400, 'invalid_request', 'endpoint и keys обязательны');
    }
    pushSubscriptionEndpoints.add(body.endpoint);
    return new HttpResponse(null, { status: 201 });
  }),
  http.post(`${BASE}/push-subscriptions/unsubscribe`, async ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const body = (await request.json()) as { endpoint?: string };
    if (body.endpoint) pushSubscriptionEndpoints.delete(body.endpoint);
    return new HttpResponse(null, { status: 204 });
  }),
];
