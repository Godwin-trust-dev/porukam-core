/**
 * `GET /v1/evidence/retention-policy` (ADR-137) — публичный, без авторизации:
 * политика хранения документов сделки. Зеркало `apps.evidence.selectors.
 * retention_policy`: дни из настроек дедлайнов (здесь — значения ADR),
 * `hashes_forever` — принцип, не настройка.
 */
import { http, HttpResponse } from 'msw';
import type { RetentionPolicy } from '@porukam/core';
import { findDisputeEvidence } from './disputesDb';
import { getEvidence } from './realContractsDb';

const BASE = '/v1';

export const MOCK_RETENTION_POLICY: RetentionPolicy = {
  hot_days: 90,
  archive_days: 365,
  notice_days: 10,
  dispute_pause_cap_days: 180,
  hashes_forever: true,
};

export const evidenceHandlers = [
  // `retention-policy` — ПЕРЕД `:evidenceId`: MSW берёт первый совпавший
  // хендлер, и параметрический путь иначе съел бы фиксированный.
  http.get(`${BASE}/evidence/retention-policy`, () =>
    HttpResponse.json(MOCK_RETENTION_POLICY, { headers: { 'Cache-Control': 'public, max-age=86400' } }),
  ),

  /* `GET /evidence/{id}` (`EvidenceDetailView`) — метаданные одного файла:
     лента спора добирает им имя и тип вложений, которых нет ни в списке
     доказательств спора, ни в списке доказательств этапа. */
  http.get(`${BASE}/evidence/:evidenceId`, ({ request, params }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return new HttpResponse(JSON.stringify({ status: 401, code: 'unauthorized', title: 'unauthorized', detail: 'Нужен вход.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }
    const id = String(params.evidenceId);
    const found = findDisputeEvidence(id) ?? safeGetEvidence(id);
    if (!found) {
      return new HttpResponse(JSON.stringify({ status: 404, code: 'not_found', title: 'not_found', detail: 'Доказательство не найдено.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }
    return HttpResponse.json(found);
  }),
];

/** `getEvidence` бросает `RealMockError` — здесь «нет такого файла» это
 * обычный ответ 404, а не исключение. */
function safeGetEvidence(evidenceId: string) {
  try {
    return getEvidence(evidenceId);
  } catch {
    return null;
  }
}
