import { http, HttpResponse } from 'msw';
import type { ExportOptionsInput } from '@porukam/core';
import { getArchivePreview, getExportJob, revokeLink, startExport } from './archiveDb';
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

function run<T>(fn: () => T, status = 200): HttpResponse {
  try {
    return HttpResponse.json(fn() as object, { status });
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.message);
    throw e;
  }
}

/** Экспорт архива сделки — зеркало `apps.archive` (ADR-139, DEV-12 §12): доменный контур,
 * требует X-Acting-Profile; состав пакета без ролевого ветвления (§4 «симметрия»), различаются
 * только СВОИ ссылки. `GET /me/drive-backup` бэк не реализует — хендлера нет. */
export const archiveHandlers = [
  http.get(`${BASE}/contracts/:id/archive`, ({ request, params }) => auth(request) ?? run(() => getArchivePreview(String(params.id)))),
  http.post(`${BASE}/contracts/:id/archive/export`, async ({ request, params }) => {
    const a = auth(request);
    if (a) return a;
    // Idempotency-Key обязателен (400 `idempotency_key_required`) — сборка тяжёлая.
    if (!request.headers.get('Idempotency-Key')) return problem(400, 'idempotency_key_required', 'Заголовок Idempotency-Key обязателен.');
    const body = (await request.json().catch(() => ({}))) as Partial<ExportOptionsInput>;
    return run(
      () =>
        startExport(String(params.id), {
          include_originals: body.include_originals ?? true,
          manifest_only: body.manifest_only ?? false,
        }),
      202,
    );
  }),
  http.get(`${BASE}/contracts/:id/archive/export/:exportId`, ({ request, params }) =>
    auth(request) ?? run(() => getExportJob(String(params.id), String(params.exportId))),
  ),
  http.post(`${BASE}/archive/links/:linkId/revoke`, ({ request, params }) => auth(request) ?? run(() => revokeLink(String(params.linkId)))),
];
