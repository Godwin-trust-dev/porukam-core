/**
 * `GET /v1/locales` (DEV-16a §3) — публичный эндпоинт, без авторизации: список языков
 * нужен и гостю до логина (глобус в шапке гостя/на подписании по инвайт-ссылке).
 */
import { http, HttpResponse } from 'msw';
import { listLocales } from './localesDb';

const BASE = '/v1';

export const localesHandlers = [
  http.get(`${BASE}/locales`, () => HttpResponse.json(listLocales())),
];
