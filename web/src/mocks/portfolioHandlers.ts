import { http, HttpResponse } from 'msw';
import type { PortfolioPhotoDto, PortfolioProjectDto } from '@porukam/core';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/** Мок портфолио (ADR-115/120): проекты по профилям, галерея до 5 фото (первое — основное = photo_url). */
interface ProjectRecord extends PortfolioProjectDto {
  profile_id: string;
}

let seq = 0;
const projects: ProjectRecord[] = [];

export function resetPortfolio(): void {
  projects.length = 0;
  seq = 0;
  seedPortfolio();
}

function seedPortfolio(): void {
  projects.push({
    profile_id: 'pf-mock-contractor-1',
    id: 'pp-1',
    photo_url: '/v1/portfolio/projects/pp-1/photo?v=seed',
    photos: [
      { id: 'ph-1', url: '/v1/portfolio/projects/pp-1/photos/ph-1?v=seed1', order: 0, is_primary: true },
      { id: 'ph-2', url: '/v1/portfolio/projects/pp-1/photos/ph-2?v=seed2', order: 1, is_primary: false },
    ],
    title: 'Ванная под ключ',
    description: 'Плитка, сантехника, тёплый пол.',
    sphere: 'renovation',
    started_at: '2026-03-01',
    completed_at: '2026-04-15',
    location_label: 'Алматы',
    media: [],
    order: 0,
    source: 'manual',
    is_verified: false,
    verified_facts: {},
    is_published: true,
  });
}

seedPortfolio();

const strip = ({ profile_id: _p, ...rest }: ProjectRecord): PortfolioProjectDto => rest;

/** Порядок без дыр, первое — основное, photo_url — его зеркало (как сервис бэка). */
function syncCover(record: ProjectRecord): void {
  record.photos = record.photos.map((p, i) => ({ ...p, order: i, is_primary: i === 0 }));
  record.photo_url = record.photos[0] ? `/v1/portfolio/projects/${record.id}/photo?v=${record.photos[0].id}` : null;
}

export const portfolioHandlers = [
  http.get(`${BASE}/profiles/:pid/portfolio/projects`, ({ params }) =>
    HttpResponse.json(projects.filter((p) => p.profile_id === params.pid).map(strip)),
  ),
  http.post(`${BASE}/profiles/:pid/portfolio/projects`, async ({ request, params }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) return problem(401, 'unauthorized', 'Нужен вход.');
    const body = (await request.json()) as { title: string; sphere: string; description?: string; started_at?: string | null; completed_at?: string; location_label?: string };
    if (!body.completed_at) return problem(400, 'invalid_request', 'completed_at: обязательное поле.');
    if (body.started_at && body.started_at > body.completed_at) return problem(422, 'portfolio_dates_invalid', 'Дата начала позже даты завершения.');
    seq += 1;
    const record: ProjectRecord = {
      profile_id: String(params.pid),
      id: `pp-n-${seq}`,
      photo_url: null,
      photos: [],
      title: body.title,
      description: body.description ?? '',
      sphere: body.sphere,
      started_at: body.started_at ?? null,
      completed_at: body.completed_at,
      location_label: body.location_label ?? '',
      media: [],
      order: 100 + seq,
      source: 'manual',
      is_verified: false,
      verified_facts: {},
      is_published: false,
    };
    projects.push(record);
    return HttpResponse.json(strip(record), { status: 201 });
  }),
  http.patch(`${BASE}/portfolio/projects/:id`, async ({ request, params }) => {
    const record = projects.find((p) => p.id === params.id);
    if (!record) return problem(404, 'not_found', 'Проект не найден.');
    const patch = (await request.json()) as Partial<PortfolioProjectDto>;
    const started = patch.started_at === undefined ? record.started_at : patch.started_at;
    const completed = patch.completed_at ?? record.completed_at;
    if (started && completed && started > completed) return problem(422, 'portfolio_dates_invalid', 'Дата начала позже даты завершения.');
    Object.assign(record, patch, { id: record.id, photos: record.photos, photo_url: record.photo_url });
    return HttpResponse.json(strip(record));
  }),
  http.post(`${BASE}/portfolio/projects/:id/photos`, ({ params }) => {
    const record = projects.find((p) => p.id === params.id);
    if (!record) return problem(404, 'not_found', 'Проект не найден.');
    if (record.photos.length >= 5) return problem(409, 'portfolio_photos_limit', 'Не больше 5 фото на проект.');
    seq += 1;
    const photo: PortfolioPhotoDto = { id: `ph-n-${seq}`, url: `/v1/portfolio/projects/${record.id}/photos/ph-n-${seq}?v=${seq}`, order: record.photos.length, is_primary: record.photos.length === 0 };
    record.photos.push(photo);
    syncCover(record);
    return HttpResponse.json(strip(record), { status: 201 });
  }),
  http.delete(`${BASE}/portfolio/projects/:id/photos/:photoId`, ({ params }) => {
    const record = projects.find((p) => p.id === params.id);
    if (!record) return problem(404, 'not_found', 'Проект не найден.');
    record.photos = record.photos.filter((p) => p.id !== params.photoId);
    syncCover(record);
    return HttpResponse.json(strip(record));
  }),
  http.post(`${BASE}/portfolio/projects/:id/photos/:photoId/primary`, ({ params }) => {
    const record = projects.find((p) => p.id === params.id);
    const photo = record?.photos.find((p) => p.id === params.photoId);
    if (!record || !photo) return problem(404, 'not_found', 'Фото не найдено.');
    record.photos = [photo, ...record.photos.filter((p) => p.id !== photo.id)];
    syncCover(record);
    return HttpResponse.json(strip(record));
  }),
  // ADR-115 (совместимость): заменить/убрать основное фото.
  http.post(`${BASE}/portfolio/projects/:id/photo`, ({ params }) => {
    const record = projects.find((p) => p.id === params.id);
    if (!record) return problem(404, 'not_found', 'Проект не найден.');
    seq += 1;
    const photo: PortfolioPhotoDto = { id: `ph-n-${seq}`, url: `/v1/portfolio/projects/${record.id}/photos/ph-n-${seq}?v=${seq}`, order: 0, is_primary: true };
    record.photos = [photo, ...record.photos.slice(1)];
    syncCover(record);
    return HttpResponse.json(strip(record));
  }),
  http.delete(`${BASE}/portfolio/projects/:id/photo`, ({ params }) => {
    const record = projects.find((p) => p.id === params.id);
    if (!record) return problem(404, 'not_found', 'Проект не найден.');
    record.photos = record.photos.slice(1);
    syncCover(record);
    return HttpResponse.json(strip(record));
  }),
  http.post(`${BASE}/portfolio/projects/:id/publish`, ({ params }) => {
    const record = projects.find((p) => p.id === params.id);
    if (!record) return problem(404, 'not_found', 'Проект не найден.');
    record.is_published = true;
    return HttpResponse.json(strip(record));
  }),
];
