/**
 * `GET /v1/legal/<doc>` (docs/tasks/Задача_feat_l10n-launch-surfaces.md §B) —
 * публичный эндпоинт, как /v1/locales: ссылки на Условия и Политику висят на
 * /welcome, то есть документ нужен гостю до всякого входа.
 */
import { http, HttpResponse } from 'msw';
import { findLegalDocument } from './legalDb';

const BASE = '/v1';

export const legalHandlers = [
  http.get(`${BASE}/legal/:doc`, ({ params, request }) => {
    const requested = new URL(request.url).searchParams.get('locale') ?? 'en';
    const document = findLegalDocument(String(params.doc), requested);
    if (!document) {
      return new HttpResponse(
        JSON.stringify({ status: 404, code: 'not_found', title: 'not_found', detail: 'Документ не найден' }),
        { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
      );
    }
    return HttpResponse.json(document);
  }),
];
