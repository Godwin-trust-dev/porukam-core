import { http, HttpResponse } from 'msw';
import type { AcceptanceRemark } from '@porukam/core';
import { acceptMilestone, getMilestoneAcceptance, returnMilestone } from './acceptanceDb';
import { MockError } from './contractsDb';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function auth(request: Request): HttpResponse | null {
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
    return problem(401, 'unauthorized', 'Нужен вход.');
  }
  if (!request.headers.get('X-Acting-Profile')) {
    return problem(400, 'acting_profile_required', 'Не выбран профиль актёра.');
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

/** Приёмка этапа (DEV-04): доменный контур — требует X-Acting-Profile (роль — заказчик, гейт на странице). */
export const acceptanceHandlers = [
  http.get(`${BASE}/contracts/:id/milestones/:mid`, ({ request, params }) =>
    auth(request) ?? run(() => getMilestoneAcceptance(String(params.id), String(params.mid))),
  ),
  http.post(`${BASE}/contracts/:id/milestones/:mid/accept`, ({ request, params }) =>
    auth(request) ?? run(() => acceptMilestone(String(params.id), String(params.mid))),
  ),
  http.post(`${BASE}/contracts/:id/milestones/:mid/return`, async ({ request, params }) => {
    const a = auth(request);
    if (a) return a;
    const body = (await request.json().catch(() => ({}))) as { remarks?: AcceptanceRemark[] };
    return run(() => returnMilestone(String(params.id), String(params.mid), body.remarks ?? []));
  }),
];
