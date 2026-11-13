import { http, HttpResponse } from 'msw';
import type { WorkAreaWriteItem } from '@porukam/core';
import {
  WorkAreaDuplicateError,
  WorkAreaInvalidPayloadError,
  WorkAreaLimitError,
  WorkAreaLocationMismatchError,
  WorkAreaUnknownLocationError,
  listWorkAreas,
  replaceWorkAreas,
} from './workAreasDb';

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
  return null;
}

function viewerLocale(request: Request): string {
  return request.headers.get('Accept-Language') || 'ru';
}

/**
 * `GET`/`PUT /v1/profiles/{id}/work-areas` (план 11.09 §4, ADR-182) —
 * мок-зеркало `apps.profiles.api.views.ProfileWorkAreasView`. Права
 * (владелец/представитель, чужой профиль → 403) в моке не различаются —
 * этот контур мока проверяется только на «свой» профиль (как и остальные
 * profilesHandlers), достаточно требовать вход.
 */
export const workAreasHandlers = [
  http.get(`${BASE}/profiles/:id/work-areas`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return HttpResponse.json(listWorkAreas(String(params.id)));
  }),

  http.put(`${BASE}/profiles/:id/work-areas`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const items = (await request.json().catch(() => [])) as WorkAreaWriteItem[];
    try {
      const areas = replaceWorkAreas(String(params.id), items, viewerLocale(request));
      return HttpResponse.json(areas);
    } catch (err) {
      if (err instanceof WorkAreaLimitError) return problem(422, 'work_area_limit', err.message);
      if (err instanceof WorkAreaDuplicateError) return problem(422, 'work_area_duplicate', err.message);
      if (err instanceof WorkAreaLocationMismatchError) return problem(422, 'work_area_location_mismatch', err.message);
      if (err instanceof WorkAreaUnknownLocationError) return problem(422, 'work_area_unknown_location', err.message);
      if (err instanceof WorkAreaInvalidPayloadError) return problem(422, 'work_area_invalid_payload', err.message);
      throw err;
    }
  }),
];
