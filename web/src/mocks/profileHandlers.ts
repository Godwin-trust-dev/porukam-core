import { http, HttpResponse } from 'msw';
import {
  addContact,
  claimHandle,
  getMe,
  listContacts,
  getMyConsents,
  isHandleAvailable,
  listSessions,
  logoutAllSessions,
  logoutSession,
  patchProfile,
  recordMyConsent,
  removeContact,
  MockError,
  type ProfilePatch,
} from './profileDb';
import { persistActiveAfterProfilePatch } from './authGlobalDb';
import { handleDirectory } from './catalog';

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

/** Ветка мока, выбранная снаружи: заголовок (ручная проверка) или
 * sessionStorage (тесты/e2e — обычный код приложения заголовков не шлёт). */
export const MOCK_SCENARIO_KEY = 'porukam.mockScenario';

function mockScenario(request: Request): string | null {
  const fromHeader = request.headers.get('X-Mock-Scenario');
  if (fromHeader) return fromHeader;
  try {
    return sessionStorage.getItem(MOCK_SCENARIO_KEY);
  } catch {
    return null;
  }
}

/**
 * Личный кабинет владельца (DEV-02 §6): PATCH-мутации оптимистичны, поверх
 * in-memory стора `profileDb`. Все эндпоинты — личные (Bearer, без X-Acting-Profile).
 */
export const profileHandlers = [
  http.patch(`${BASE}/users/me`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const patch = (await request.json().catch(() => ({}))) as ProfilePatch;
    return run(() => {
      const result = patchProfile(patch);
      // GLOBAL-сессия (ГВ.2): зеркалим изменение в реестр аккаунтов, чтобы
      // повторный вход тем же sub видел заявленный @handle/имя (no-op для OTP).
      persistActiveAfterProfilePatch();
      return result;
    });
  }),

  /**
   * DELETE /users/me (ADR-169) — удаление аккаунта.
   *
   * По умолчанию 202: мок-аккаунт «уходит» и фронт чистит сессию. Ветку 409
   * (`account_deletion_blocked`) включает сценарий `deletion-blocked` — тот же
   * приём выбора ветки вызывающей стороной, что `X-Mock-Role` в
   * contractHandlers: состояние мок-базы от него не зависит.
   *
   * Два входа в сценарий, потому что запрос уходит из ОБЫЧНОГО кода приложения
   * (`useDeleteAccount`), и специального заголовка ради мока оно не шлёт:
   * `X-Mock-Scenario` — для ручной проверки (devtools/curl), ключ
   * `porukam.mockScenario` в sessionStorage — для тестов и e2e, которые
   * выставляют его до перехода на экран.
   *
   * Числа в `context` фиксированные: эндпоинт ЛИЧНЫЙ (без X-Acting-Profile),
   * посчитать «сколько у этого актёра незакрытых договоров» по мок-базе
   * нечем, а проверяем мы показ чисел, а не сам подсчёт (он на бэке).
   */
  http.delete(`${BASE}/users/me`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    if (mockScenario(request) === 'deletion-blocked') {
      return new HttpResponse(
        JSON.stringify({
          status: 409,
          code: 'account_deletion_blocked',
          title: 'account_deletion_blocked',
          detail: 'Есть незавершённые договоры или открытые споры.',
          context: { active_contracts: 2, open_disputes: 1 },
        }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      );
    }
    return HttpResponse.json({ deleted_at: new Date().toISOString() }, { status: 202 });
  }),

  http.get(`${BASE}/users/handle-available`, ({ request }) => {
    const handle = new URL(request.url).searchParams.get('handle') ?? '';
    return HttpResponse.json({ available: isHandleAvailable(handle) });
  }),

  // POST /users/me/handle — реальный контракт (apps.social), ОТДЕЛЬНО от
  // PATCH /users/me выше (docs/tasks/Задача_fix_web-profile-handle-real-api.md).
  http.post(`${BASE}/users/me/handle`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { value?: string };
    return run(() => {
      const result = claimHandle(body.value ?? '');
      persistActiveAfterProfilePatch();
      return { handle: (result.handle ?? '').replace(/^@/, ''), kind: 'user', verified: false };
    });
  }),

  // GET/POST /users/me/consents (apps.social) — согласия ПОСЛЕ регистрации
  // (docs/tasks/Задача_fix_web-profile-settings-real-api.md); НЕ путать с
  // `/users/me/privacy-consents-global` (authGlobalHandlers.ts, стартовый пакет).
  http.get(`${BASE}/users/me/consents`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return HttpResponse.json(getMyConsents());
  }),

  http.post(`${BASE}/users/me/consents`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { consent_type?: string; value?: boolean };
    return run(() => {
      if (body.consent_type !== 'phone_discoverability') {
        throw new MockError(422, 'invalid_consent_type', 'Неизвестный тип согласия.');
      }
      return recordMyConsent('phone_discoverability', Boolean(body.value));
    });
  }),

  http.get(`${BASE}/sessions`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return HttpResponse.json({ results: listSessions() });
  }),

  http.delete(`${BASE}/sessions/:id`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => {
      logoutSession(String(params.id));
      return { results: listSessions() };
    });
  }),

  http.post(`${BASE}/sessions/logout-all`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => {
      logoutAllSessions();
      return { results: listSessions() };
    });
  }),

  // Справочник контактов (apps.social, ADR-106) — in-memory, демо-контур.
  http.get(`${BASE}/users/me/contacts`, ({ request }) => auth(request) ?? HttpResponse.json(listContacts())),
  http.post(`${BASE}/users/me/contacts`, async ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { target_handle?: string; target_user_id?: string };
    const handle = body.target_handle ? `@${body.target_handle.replace(/^@/, '')}` : null;
    const existing = listContacts().find((c) => handle && c.target_handle === handle);
    if (existing) return HttpResponse.json(existing, { status: 201 });
    // Имя берём из справочника хендлов — так же, как реальный бэк отдаёт
    // `target_display_name` профиля, а не пустую строку.
    const known = handle ? handleDirectory.find((h) => h.handle === handle) : undefined;
    const row = {
      id: `contact-${handle?.replace('@', '') ?? listContacts().length + 1}`,
      target_user: body.target_user_id ?? `user-${listContacts().length + 1}`,
      target_handle: handle,
      target_display_name: known?.display_name ?? '',
      target_profile_id: null,
      target_avatar_url: null,
      display_name: null,
      source: 'manual',
      is_mutual: false,
      created_at: new Date().toISOString(),
    };
    addContact(row);
    return HttpResponse.json(row, { status: 201 });
  }),
  http.delete(`${BASE}/users/me/contacts/:id`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    if (!removeContact(String(params['id']))) return problem(404, 'not_found', 'Контакт не найден.');
    return new HttpResponse(null, { status: 204 });
  }),
];

// getMe используется handlers.ts (GET /users/me) — переиспользуем мутируемый стор.
export { getMe };
