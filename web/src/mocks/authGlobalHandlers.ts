/**
 * GLOBAL-вход через Google + онбординг (DEV-auth-onboarding, ГВ.2/ADR-071) —
 * эндпоинты, зеркалящие реальный бэк (`/auth/google/*`,
 * `/users/me/privacy-consents-global`), + честно помеченные МОК-ТОЛЬКО
 * (`/users/me/drive-backup`, `/invites/:token`) там, где бэк ещё не построен.
 * @handle/имя/«только @handle» намеренно НЕ дублируются здесь — идут через
 * уже существующие `PATCH /users/me` и `PATCH /users/me/settings`
 * (`profileHandlers.ts`), единый источник правды для `me`.
 */
import { http, HttpResponse } from 'msw';
import {
  buildAuthorizeUrl,
  completeDriveConnect,
  completeGoogleLogin,
  connectDriveBackup,
  getDriveBackup,
  getGlobalConsents,
  getInvite,
  recordGlobalConsents,
  MockError,
} from './authGlobalDb';
import type { GlobalPrivacyConsentsInput } from '@porukam/core';

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

async function run(fn: () => unknown): Promise<HttpResponse> {
  try {
    return HttpResponse.json(fn() as object);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.message);
    throw e;
  }
}

export const authGlobalHandlers = [
  // Анонимно — на этом шаге пользователя ещё нет (первый вход = регистрация, ADR-071).
  http.get(`${BASE}/auth/google/authorize-url`, () => HttpResponse.json(buildAuthorizeUrl())),

  http.post(`${BASE}/auth/google/callback`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { code?: string; state?: string };
    return run(() => {
      const { user } = completeGoogleLogin(body.code ?? '', body.state ?? '');
      void user; // ответ — только токены (тот же контур, что OTP); /users/me читает сессию отдельно.
      return { access: 'mock.access.jwt', refresh: 'mock.refresh.jwt' };
    });
  }),

  http.get(`${BASE}/users/me/privacy-consents-global`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getGlobalConsents());
  }),

  http.post(`${BASE}/users/me/privacy-consents-global`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as Partial<GlobalPrivacyConsentsInput>;
    return run(() => {
      if (
        typeof body.pd_processing !== 'boolean' ||
        typeof body.profile_public !== 'boolean' ||
        typeof body.phone_discoverability !== 'boolean' ||
        typeof body.reputation_history_basis !== 'boolean'
      ) {
        throw new MockError(422, 'validation_error', 'Все четыре согласия обязательны.');
      }
      return recordGlobalConsents(body as GlobalPrivacyConsentsInput);
    });
  }),

  // МОК-ТОЛЬКО — реальный Drive-контур: ГВ.3 (docs/tasks/global-wave.md).
  http.get(`${BASE}/users/me/drive-backup`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getDriveBackup());
  }),
  http.post(`${BASE}/users/me/drive-backup`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => connectDriveBackup());
  }),

  // Зеркало РЕАЛЬНОГО Drive-контура (ADR-084, `EVIDENCE_DRIVE_PROVIDER=real`) —
  // приём callback-страницы `/settings/drive/callback`, отдельно от МОК-ТОЛЬКО выше.
  http.post(`${BASE}/users/me/drive/connect/callback`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { code?: string; state?: string };
    return run(() => {
      completeDriveConnect(body.code ?? '', body.state ?? '');
      return null;
    });
  }),

  // МОК-ТОЛЬКО — у бэка сейчас нет контура приглашений по ссылке.
  http.get(`${BASE}/invites/:token`, ({ params }) => run(() => getInvite(String(params.token)))),
];
