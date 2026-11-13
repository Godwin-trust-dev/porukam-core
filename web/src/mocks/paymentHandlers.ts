import { http, HttpResponse } from 'msw';
import type { RevisionAuthorRole } from '@porukam/core';
import { paymentsDb } from './paymentsDb';
import { MockError } from './contractsDb';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function run<T>(fn: () => T): HttpResponse {
  try {
    return HttpResponse.json(fn() as object);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.message);
    throw e;
  }
}

function auth(request: Request): HttpResponse | null {
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
    return problem(401, 'unauthorized', 'Нужен вход.');
  }
  return null;
}

function role(request: Request): RevisionAuthorRole {
  const r = request.headers.get('X-Mock-Role');
  return r === 'contractor' ? 'contractor' : 'customer';
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json().catch(() => ({}))) as T;
}

export const paymentHandlers = [
  http.post(`${BASE}/contracts/:id/payments`, async ({ request, params }) => {
    const a = auth(request);
    if (a) return a;
    const b = await body<{ stageId?: string; method?: 'cash' | 'sbp' }>(request);
    if (!b.stageId || !b.method) return problem(422, 'invalid_request', 'Нужны stageId и method');
    return run(() => paymentsDb.create(String(params.id), b.stageId!, b.method!, role(request)));
  }),

  http.get(`${BASE}/payments/:pid`, ({ request, params }) => auth(request) ?? run(() => paymentsDb.get(String(params.pid)))),

  http.post(`${BASE}/payments/:pid/confirm`, async ({ request, params }) => {
    const a = auth(request);
    if (a) return a;
    const b = await body<{ by?: 'payer' | 'payee' }>(request);
    if (!b.by) return problem(422, 'invalid_request', 'Нужен by');
    return run(() => paymentsDb.confirm(String(params.pid), b.by!));
  }),

  http.post(`${BASE}/payments/:pid/dispute`, ({ request, params }) =>
    auth(request) ?? run(() => paymentsDb.dispute(String(params.pid))),
  ),
];
