/**
 * Вход/регистрация по e-mail шестизначным кодом (ADR-168, решение владельца
 * 06.09.2026) — зеркало контракта `POST /v1/auth/email/request|verify`.
 * Реальный бэк строится ПАРАЛЛЕЛЬНО; мок держит фронт и e2e на ногах и
 * фиксирует ровно тот набор кодов ошибок, на который реагирует экран.
 *
 * Мок БЕЗ ПАМЯТИ: ветка ответа выбирается адресом и кодом, а не состоянием —
 * каждый сценарий (в т.ч. «отключено», «слишком часто») воспроизводится с
 * первого шага и не протекает в соседний тест.
 */
import { http, HttpResponse } from 'msw';
import { DEV_OTP } from './data';

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

/** Адрес-маркер: «канал выключен» (403 email_login_disabled). */
export const MOCK_EMAIL_DISABLED = 'disabled@porukam.test';
/** Адрес-маркер: «слишком часто» (429 otp_rate_limited, retry_after 30). */
export const MOCK_EMAIL_RATE_LIMITED = 'limited@porukam.test';
/** Код-маркер: «код истёк» (400 otp_code_expired) — отдельно от «неверный». */
export const MOCK_EMAIL_EXPIRED_CODE = '000000';

/** Тот же грубый разбор, что у формы: есть `@` и точка в домене. */
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const normalize = (s: string | undefined) => (s ?? '').trim().toLowerCase();

export const emailAuthHandlers = [
  http.post(`${BASE}/auth/email/request`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const email = normalize(body.email);
    if (email === MOCK_EMAIL_DISABLED) {
      return problem(403, 'email_login_disabled', 'Вход по почте отключён.');
    }
    if (email === MOCK_EMAIL_RATE_LIMITED) {
      return problem(429, 'otp_rate_limited', 'Слишком часто. Повторите позже.', { retry_after: 30 });
    }
    if (!looksLikeEmail(email)) {
      return problem(400, 'validation_error', 'Проверьте адрес почты.', {
        errors: { email: ['Проверьте адрес почты.'] },
      });
    }
    // 200 для ЛЮБОГО синтаксически верного адреса: есть ли такой аккаунт —
    // не раскрываем (контракт ADR-168). `dev_hint` — только стенд.
    return HttpResponse.json({ dev_hint: DEV_OTP });
  }),

  http.post(`${BASE}/auth/email/verify`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { email?: string; code?: string };
    const email = normalize(body.email);
    if (email === MOCK_EMAIL_DISABLED) {
      return problem(403, 'email_login_disabled', 'Вход по почте отключён.');
    }
    if (email === MOCK_EMAIL_RATE_LIMITED) {
      return problem(429, 'otp_rate_limited', 'Слишком часто. Повторите позже.', { retry_after: 30 });
    }
    if (body.code === MOCK_EMAIL_EXPIRED_CODE) {
      return problem(400, 'otp_code_expired', 'Код истёк. Запросите новый.');
    }
    if (body.code !== DEV_OTP) {
      return problem(400, 'otp_invalid_code', 'Неверный код.');
    }
    // Та же пара токенов, что у OTP и Google, — вход неотличим по последствиям.
    return HttpResponse.json({ access: 'mock.access.jwt', refresh: 'mock.refresh.jwt' });
  }),
];
