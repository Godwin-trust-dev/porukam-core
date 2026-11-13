import { http, HttpResponse } from 'msw';
import { parseMultipart } from './multipart';
import {
  ensureProfileSettings,
  getProfileAvatar,
  patchProfileSettings,
  ProfileWorkTypeSphereNotDeclaredError,
  ProfileWorkTypesInvalidError,
  ProfileWorkTypesLimitError,
  removeProfileAvatar,
  setProfileAvatar,
  type ProfileSettingsPatch,
} from './profilesDb';

/** Лимит — зеркало `PROFILE_AVATAR_MAX_UPLOAD_BYTES` (5 МБ). Мок не умеет
 * декодировать изображение, «это картинка» проверяется по MIME-типу. */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

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

/**
 * GET/PATCH /profiles/{id} (apps.profiles) — docs/tasks/
 * Задача_fix_web-profile-settings-real-api.md, ADR-087. GET на боевом бэке
 * ПУБЛИЧНЫЙ (`AllowAny`) — тот же эндпоинт видит гость по прямой ссылке;
 * здесь без auth-гейта, как на бэке. PATCH — личный (только владелец).
 */
export const profilesHandlers = [
  http.get(`${BASE}/profiles/:id`, ({ params }) => {
    return HttpResponse.json(ensureProfileSettings(String(params.id)));
  }),

  http.patch(`${BASE}/profiles/:id`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const patch = (await request.json().catch(() => ({}))) as ProfileSettingsPatch;
    try {
      return HttpResponse.json(patchProfileSettings(String(params.id), patch));
    } catch (err) {
      // ADR-190/191 — зеркало 422-х `apps.profiles.api.views` (см. ADR-190
      // «Не сделано»: тексты этих кодов и в l10n-пакетах бэка не заведены,
      // `title` на моке — тот же код, фронт печатает свой человекочитаемый
      // текст сам по `ApiError.code`, как и для `work_area_limit`/др.).
      if (err instanceof ProfileWorkTypesLimitError) return problem(422, 'profile_work_types_limit', err.message);
      if (err instanceof ProfileWorkTypeSphereNotDeclaredError) return problem(422, 'work_type_sphere_not_declared', err.message);
      if (err instanceof ProfileWorkTypesInvalidError) return problem(422, 'invalid_work_type', err.message);
      throw err;
    }
  }),

  // --- Фото профиля (ADR-103) ---
  http.get(`${BASE}/profiles/:id/avatar`, ({ params }) => {
    const stored = getProfileAvatar(String(params.id));
    if (!stored) return problem(404, 'not_found', 'Фото нет.');
    return new HttpResponse(stored.bytes, { status: 200, headers: { 'Content-Type': stored.type } });
  }),

  http.post(`${BASE}/profiles/:id/avatar`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const parsed = await parseMultipart(request);
    const file = parsed?.files['file'];
    if (!file) return problem(400, 'validation_error', 'Нужен файл `file`.');
    if (file.size > AVATAR_MAX_BYTES) return problem(413, 'avatar_too_large', 'Файл слишком большой.');
    if (!file.type.startsWith('image/')) return problem(422, 'invalid_avatar_image', 'Файл не распознан как изображение.');
    return HttpResponse.json(setProfileAvatar(String(params.id), file.bytes, file.type));
  }),

  http.delete(`${BASE}/profiles/:id/avatar`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return HttpResponse.json(removeProfileAvatar(String(params.id)));
  }),
];
