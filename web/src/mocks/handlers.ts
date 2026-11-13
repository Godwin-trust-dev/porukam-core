import { http, HttpResponse } from 'msw';
import { DEV_OTP } from './data';
import { contractHandlers } from './contractHandlers';
import { reputationHandlers } from './reputationHandlers';
import { getMe, profileHandlers } from './profileHandlers';
import { profilesHandlers } from './profilesHandlers';
import { dashboardHandlers } from './dashboardHandlers';
import { acceptanceHandlers } from './acceptanceHandlers';
import { paymentHandlers } from './paymentHandlers';
import { authGlobalHandlers } from './authGlobalHandlers';
import { emailAuthHandlers } from './emailAuthHandlers';
import { archiveHandlers } from './archiveHandlers';
import { stageExecutionHandlers } from './stageExecutionHandlers';
import { notificationsHandlers } from './notificationsHandlers';
import { contractsListHandlers } from './contractsListHandlers';
import { realContractsHandlers } from './realContractsHandlers';
import { localesHandlers } from './localesHandlers';
import { legalHandlers } from './legalHandlers';
import { sectionsHandlers } from './sectionsHandlers';
import { disputesHandlers } from './disputesHandlers';
import { deviceTokenHandlers } from './deviceTokenHandlers';
import { pushHandlers } from './pushHandlers';
import { chatHandlers } from './chatHandlers';
import { groupsHandlers } from './groupsHandlers';
import { groupPortfolioHandlers } from './groupPortfolioHandlers';
import { portfolioHandlers } from './portfolioHandlers';
import { evidenceHandlers } from './evidenceHandlers';
import { analyticsHandlers } from './analyticsHandlers';
import { geoHandlers } from './geoHandlers';
import { workAreasHandlers } from './workAreasHandlers';

const BASE = '/v1';

function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail, ...extra }), {
    status,
    headers: {
      'Content-Type': 'application/problem+json',
      ...(extra.retry_after ? { 'Retry-After': String(extra.retry_after) } : {}),
    },
  });
}

const onlyDigits = (s: string) => s.replace(/\D/g, '');

export const handlers = [
  // ── Auth ──
  http.post(`${BASE}/auth/otp/request`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { phone?: string };
    const digits = onlyDigits(body.phone ?? '');
    // Демонстрация 429: телефон из одних нулей → слишком часто.
    if (/^0+$/.test(digits) && digits.length >= 10) {
      return problem(429, 'rate_limited', 'Слишком часто. Повторите позже.', { retry_after: 30 });
    }
    if (digits.length < 10) {
      return problem(422, 'invalid_phone', 'Проверьте номер телефона.');
    }
    return HttpResponse.json({ sent: true, dev_hint: DEV_OTP });
  }),

  http.post(`${BASE}/auth/otp/verify`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { code?: string };
    if (body.code !== DEV_OTP) {
      return problem(422, 'invalid_code', 'Неверный код.');
    }
    return HttpResponse.json({ access: 'mock.access.jwt', refresh: 'mock.refresh.jwt' });
  }),

  // Выход текущей сессии (замечание владельца 07.09): бэк кладёт refresh в
  // блэклист и отвечает 204 без тела.
  http.post(`${BASE}/auth/logout`, async () => new HttpResponse(null, { status: 204 })),

  http.post(`${BASE}/auth/token/refresh`, async () =>
    HttpResponse.json({ access: 'mock.access.jwt.rotated', refresh: 'mock.refresh.jwt.rotated' }),
  ),

  // ── Личный эндпоинт: требует Bearer, без X-Acting-Profile ──
  http.get(`${BASE}/users/me`, async ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    return HttpResponse.json(getMe());
  }),

  // realContractsHandlers ПЕРЕД contractsListHandlers — оба регистрируют
  // GET /contracts (реальный список, Фаза 1, ADR-088), MSW берёт первый
  // совпавший по методу+пути хендлер; старый список (ContractsListPage
  // переписана на реальный, ADR-088) практически не вызывается, но
  // порядок — единственная гарантия, что новый выигрывает детерминированно.
  // Контур разногласий и гарантии (этап 7, ADR-131) — ПЕРЕД остальными:
  // `/contracts/{id}/warranty-claims` и `/disputes/*` больше никто не
  // регистрирует, но порядок делает выигрыш детерминированным.
  ...disputesHandlers,
  ...realContractsHandlers,
  // GET/DELETE /contracts — список сделок (DEV-13, contractsListHandlers.ts); заменяет
  // старую курсорную витрину Ф1 (DealsPage, снята).
  ...contractsListHandlers,
  ...contractHandlers,
  ...reputationHandlers,
  ...profileHandlers,
  ...profilesHandlers,
  // Справочник геолокаций + регионы работы профиля (план 11.09 §4, ADR-182) —
  // рядом с profilesHandlers (тот же bounded context на фронте).
  ...geoHandlers,
  ...workAreasHandlers,
  ...dashboardHandlers,
  ...acceptanceHandlers,
  ...paymentHandlers,
  ...authGlobalHandlers,
  // Вход по e-mail кодом (ADR-168) — рядом с Google-контуром, тот же слой auth.
  ...emailAuthHandlers,
  ...archiveHandlers,
  ...stageExecutionHandlers,
  ...notificationsHandlers,
  ...localesHandlers,
  ...legalHandlers,
  ...sectionsHandlers,
  ...pushHandlers,
  ...deviceTokenHandlers,
  ...chatHandlers,
  ...groupsHandlers,
  ...groupPortfolioHandlers,
  ...portfolioHandlers,
  ...evidenceHandlers,
  ...analyticsHandlers,
];
