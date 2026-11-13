import { http, HttpResponse } from 'msw';
import type { DashboardResponse } from '@porukam/core';
import { listAttention } from './realContractsDb';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/**
 * Дашборд запуска (ADR-090) — ТОЛЬКО «требует моего действия», вычисляется
 * из `realContractsDb` (signature-requests + milestones мок-стора реального
 * контура сделки, ADR-088) — тот же приём, что бэкенд-селекторы
 * (`apps.dashboards.selectors.get_dashboard`), но на TS. Без параметров
 * (`role`/`period` из старого мок-контракта убраны целиком, ADR-090 §4);
 * `X-Acting-Profile` не обязателен (реальный бэк его тоже не требует для
 * этого эндпоинта) — без него, как и для свежего `pf-u-google-*` аккаунта
 * (не сторона ни одного мок-договора), `attention` честно пуст, без
 * специального случая (было в старом хендлере — тут не нужен).
 */
export const dashboardHandlers = [
  http.get(`${BASE}/dashboard`, ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const actingProfile = request.headers.get('X-Acting-Profile') ?? undefined;
    const data: DashboardResponse = { attention: listAttention(actingProfile) };
    return HttpResponse.json(data);
  }),
];
