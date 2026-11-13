import { http, HttpResponse } from 'msw';
import type { PaymentsSectionResponse, StagesSectionResponse } from '@porukam/core';
import { listPaymentsSection, listStagesSection } from './realContractsDb';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function actingProfile(request: Request): string {
  // Реальный бэк выводит owned-профили из JWT; мок-эквивалент — заголовок
  // актёра с фолбэком на основную персону сидов (тот же приём, что
  // `listContracts`/`listAttention`).
  return request.headers.get('X-Acting-Profile') ?? 'pf-person-1';
}

/** Разделы /stages и /payments (ADR-109, отсмотр 2026-08-22). Разногласия
 * с этапа 7 живут в `disputesHandlers.ts`: у них появился свой контур
 * (карточка, действия, окна), а не строка агрегата раздела. */
export const sectionsHandlers = [
  http.get(`${BASE}/dashboard/stages`, ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const data: StagesSectionResponse = { items: listStagesSection(actingProfile(request)) };
    return HttpResponse.json(data);
  }),
  http.get(`${BASE}/dashboard/payments`, ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const data: PaymentsSectionResponse = { items: listPaymentsSection(actingProfile(request)) };
    return HttpResponse.json(data);
  }),
];
