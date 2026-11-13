import { http, HttpResponse } from 'msw';
import { MOCK_COUNTRIES, searchCities, searchRegions } from './geoDb';

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

/** Локаль зрителя — `Accept-Language`, как её шлёт `ApiClient.getLocale()`
 * (активный `i18n.language` целиком, без парсинга весов — это не настоящий
 * заголовок браузера, см. `packages/core/src/api/client.ts`). */
export function viewerLocale(request: Request): string {
  return request.headers.get('Accept-Language') || 'ru';
}

/**
 * `GET /v1/geo/countries|regions|cities` (план 11.09 §4, ADR-181/ADR-182) —
 * мок-справочник `apps.geo`, `geoDb.ts`. Авторизованный доступ, как на
 * бэке (справочник не публичный анонимный эндпоинт).
 */
export const geoHandlers = [
  http.get(`${BASE}/geo/countries`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return HttpResponse.json(MOCK_COUNTRIES);
  }),

  http.get(`${BASE}/geo/regions`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const rows = searchRegions(url.searchParams.get('country'), url.searchParams.get('q'), viewerLocale(request));
    return HttpResponse.json(rows);
  }),

  http.get(`${BASE}/geo/cities`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const rows = searchCities(
      url.searchParams.get('country'),
      url.searchParams.get('region'),
      url.searchParams.get('q'),
      viewerLocale(request),
    );
    // Мок не пагинирует (датасет умещается целиком) — `next_cursor` всегда `null`.
    return HttpResponse.json({ items: rows, next_cursor: null });
  }),
];
