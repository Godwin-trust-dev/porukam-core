import { http, HttpResponse } from 'msw';
import type { GroupPortfolioProjectDto, PortfolioPhotoDto } from '@porukam/core';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function authed(request: Request): boolean {
  return Boolean(request.headers.get('Authorization')?.startsWith('Bearer '));
}

/** Мок портфолио объединения (ADR-128): работы по объединениям, галерея до 5
 * фото (первое — основное = photo_url). Права leader/admin проверяет бэк —
 * здесь достаточно «есть вход», как в остальных групповых моках. */
let seq = 0;
const projects: GroupPortfolioProjectDto[] = [];

export function resetGroupPortfolio(): void {
  projects.length = 0;
  seq = 0;
  seedGroupPortfolio();
}

function seedGroupPortfolio(): void {
  projects.push({
    id: 'gpp-1',
    group: 'grp-1',
    photo_url: '/v1/groups/grp-1/portfolio/projects/gpp-1/photos/gph-1?v=seed1',
    photos: [
      { id: 'gph-1', url: '/v1/groups/grp-1/portfolio/projects/gpp-1/photos/gph-1?v=seed1', order: 0, is_primary: true },
      { id: 'gph-2', url: '/v1/groups/grp-1/portfolio/projects/gpp-1/photos/gph-2?v=seed2', order: 1, is_primary: false },
    ],
    title: 'Отделка кофейни на Абая',
    description: 'Стяжка, электрика, плитка и барная стойка — вчетвером за пять недель.',
    sphere_code: 'repair',
    started_at: '2026-02-10',
    completed_at: '2026-03-18',
    location_label: 'Алматы',
    order: 0,
    created_at: '2026-03-19T10:00:00Z',
  });
}

seedGroupPortfolio();

/** Порядок без дыр, первое — основное, photo_url — его зеркало (как сервис бэка). */
function syncCover(record: GroupPortfolioProjectDto): void {
  record.photos = record.photos.map((p, i) => ({ ...p, order: i, is_primary: i === 0 }));
  record.photo_url = record.photos[0]?.url ?? null;
}

const find = (groupId: string, projectId: string): GroupPortfolioProjectDto | undefined =>
  projects.find((p) => p.id === projectId && p.group === groupId);

export const groupPortfolioHandlers = [
  http.get(`${BASE}/groups/:gid/portfolio/projects`, ({ params }) =>
    HttpResponse.json(projects.filter((p) => p.group === params.gid)),
  ),
  http.post(`${BASE}/groups/:gid/portfolio/projects`, async ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const body = (await request.json()) as {
      title: string;
      sphere_code?: string;
      description?: string;
      started_at?: string | null;
      completed_at?: string;
      location_label?: string;
    };
    if (!body.completed_at) return problem(400, 'invalid_request', 'completed_at: обязательное поле.');
    if (body.started_at && body.started_at > body.completed_at) {
      return problem(422, 'portfolio_dates_invalid', 'Дата начала позже даты завершения.');
    }
    seq += 1;
    const record: GroupPortfolioProjectDto = {
      id: `gpp-n-${seq}`,
      group: String(params.gid),
      photo_url: null,
      photos: [],
      title: body.title,
      description: body.description ?? '',
      sphere_code: body.sphere_code ?? '',
      started_at: body.started_at ?? null,
      completed_at: body.completed_at,
      location_label: body.location_label ?? '',
      order: 100 + seq,
      created_at: new Date().toISOString(),
    };
    projects.push(record);
    return HttpResponse.json(record, { status: 201 });
  }),
  http.get(`${BASE}/groups/:gid/portfolio/projects/:id`, ({ params }) => {
    const record = find(String(params.gid), String(params.id));
    return record ? HttpResponse.json(record) : problem(404, 'not_found', 'Работа не найдена.');
  }),
  http.patch(`${BASE}/groups/:gid/portfolio/projects/:id`, async ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const record = find(String(params.gid), String(params.id));
    if (!record) return problem(404, 'not_found', 'Работа не найдена.');
    const patch = (await request.json()) as Partial<GroupPortfolioProjectDto>;
    const started = patch.started_at === undefined ? record.started_at : patch.started_at;
    const completed = patch.completed_at ?? record.completed_at;
    if (started && completed && started > completed) {
      return problem(422, 'portfolio_dates_invalid', 'Дата начала позже даты завершения.');
    }
    Object.assign(record, patch, { id: record.id, group: record.group, photos: record.photos, photo_url: record.photo_url });
    return HttpResponse.json(record);
  }),
  http.delete(`${BASE}/groups/:gid/portfolio/projects/:id`, ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const index = projects.findIndex((p) => p.id === params.id && p.group === params.gid);
    if (index < 0) return problem(404, 'not_found', 'Работа не найдена.');
    projects.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${BASE}/groups/:gid/portfolio/projects/:id/photos`, ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const record = find(String(params.gid), String(params.id));
    if (!record) return problem(404, 'not_found', 'Работа не найдена.');
    if (record.photos.length >= 5) return problem(409, 'portfolio_photos_limit', 'Не больше 5 фото на работу.');
    seq += 1;
    const photo: PortfolioPhotoDto = {
      id: `gph-n-${seq}`,
      url: `/v1/groups/${record.group}/portfolio/projects/${record.id}/photos/gph-n-${seq}?v=${seq}`,
      order: record.photos.length,
      is_primary: record.photos.length === 0,
    };
    record.photos.push(photo);
    syncCover(record);
    return HttpResponse.json(record, { status: 201 });
  }),
  http.delete(`${BASE}/groups/:gid/portfolio/projects/:id/photos/:photoId`, ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const record = find(String(params.gid), String(params.id));
    if (!record) return problem(404, 'not_found', 'Работа не найдена.');
    record.photos = record.photos.filter((p) => p.id !== params.photoId);
    syncCover(record);
    return HttpResponse.json(record);
  }),
  http.post(`${BASE}/groups/:gid/portfolio/projects/:id/photos/:photoId/primary`, ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const record = find(String(params.gid), String(params.id));
    const photo = record?.photos.find((p) => p.id === params.photoId);
    if (!record || !photo) return problem(404, 'not_found', 'Фото не найдено.');
    record.photos = [photo, ...record.photos.filter((p) => p.id !== photo.id)];
    syncCover(record);
    return HttpResponse.json(record);
  }),
];
