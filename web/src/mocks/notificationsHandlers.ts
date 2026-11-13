import { http, HttpResponse } from 'msw';
import type { NotificationFilter, NotificationSettings } from '@porukam/core';
import {
  getNotificationSettings,
  listNotifications,
  markAllRead,
  markRead,
  putNotificationSettings,
  type FeedPageQuery,
} from './notificationsDb';
import { MockError } from './contractsDb';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/** Лента принадлежит владельцу ЛК — личный эндпоинт (Bearer), без X-Acting-Profile (§0/§7). */
function auth(request: Request): HttpResponse | null {
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
    return problem(401, 'unauthorized', 'Нужен вход.');
  }
  return null;
}

function run<T>(fn: () => T): HttpResponse {
  try {
    return HttpResponse.json(fn() as object);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.message);
    throw e;
  }
}

const isChannelFilter = (v: string): v is NotificationFilter =>
  v === 'all' ||
  v === 'unread' ||
  v === 'deals' ||
  v === 'chats' ||
  v === 'payments' ||
  v === 'deadlines' ||
  v === 'disputes';

/** ?limit=&cursor= — пагинация ленты (решение владельца 05.09), зеркало бэкенда. */
function pageQuery(request: Request): FeedPageQuery {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^-?\d+$/.test(rawLimit)) {
    throw new MockError(400, 'validation_error', 'limit — целое число.');
  }
  return { limit: rawLimit === null ? undefined : Number(rawLimit), cursor: params.get('cursor') };
}

/** Уведомления ЛК (DEV-14): лента + push/email-дубли. */
export const notificationsHandlers = [
  http.get(`${BASE}/notifications`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const raw = new URL(request.url).searchParams.get('filter') ?? 'all';
    const filter = isChannelFilter(raw) ? raw : 'all';
    return run(() => listNotifications(filter, Date.now(), pageQuery(request)));
  }),

  http.post(`${BASE}/notifications/read-all`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => markAllRead(pageQuery(request)));
  }),

  http.post(`${BASE}/notifications/:id/read`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => markRead(String(params.id), pageQuery(request)));
  }),

  http.get(`${BASE}/notification-settings`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getNotificationSettings());
  }),

  http.put(`${BASE}/notification-settings`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const patch = (await request.json().catch(() => ({}))) as Partial<Omit<NotificationSettings, 'in_app'>>;
    return run(() => putNotificationSettings(patch));
  }),
];
