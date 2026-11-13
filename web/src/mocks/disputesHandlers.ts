import { http, HttpResponse } from 'msw';
import type { DisputeApiResolutionType } from '@porukam/core';
import {
  DisputeMockError,
  contestWarrantyFix,
  contestWindow,
  declineDiscount,
  declineWarrantyClaim,
  getDispute,
  listContractWarrantyClaims,
  listDisputeEvidence,
  listDisputes,
  listWarrantyClaims,
  listWindows,
  proposeDiscount,
  requestFix,
  resolveDispute,
  respondToDispute,
  resubmitFix,
  satisfyWarrantyClaim,
  submitWarrantyClaim,
  submitWarrantyFix,
  uploadDisputeEvidence,
} from './disputesDb';
import { parseMultipart } from './multipart';

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

/** Актёр — X-Acting-Profile с фолбэком основной персоны сидов (тот же приём,
 * что в `realContractsHandlers`); на бэке владельческие профили выводятся из
 * JWT (`user_owned_profile_ids`). */
function actor(request: Request): string {
  return request.headers.get('X-Acting-Profile') ?? 'pf-person-1';
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json().catch(() => ({}))) as T;
}

function run(fn: () => unknown, status = 200): HttpResponse {
  try {
    return HttpResponse.json(fn() as object, { status });
  } catch (e) {
    if (e instanceof DisputeMockError) return problem(e.status, e.code, e.message);
    throw e;
  }
}

/**
 * Контур разногласий и гарантии (tech-spec.md §8.8, ADR-131) — мок-зеркало
 * `apps.disputes` + `apps.warranty` + доказательства разногласия из
 * `apps.evidence`.
 *
 * `Idempotency-Key` ни на одном из этих POST не требуется: на бэке заголовок
 * подключается точечно (`require_idempotency_key`), и эти вьюхи его не
 * объявляют — мок не должен требовать того, чего не требует Django.
 */
export const disputesHandlers = [
  http.get(`${BASE}/disputes`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    return run(() =>
      listDisputes(actor(request), {
        kind: url.searchParams.get('kind') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
      }),
    );
  }),

  http.get(`${BASE}/disputes/:disputeId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getDispute(String(params.disputeId), actor(request)));
  }),

  http.post(`${BASE}/disputes/:disputeId/respond`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string; evidence?: string[] }>(request);
    return run(() =>
      respondToDispute(String(params.disputeId), actor(request), {
        comment: input.comment ?? '',
        evidence: input.evidence ?? [],
      }),
    );
  }),

  http.get(`${BASE}/disputes/:disputeId/fix-requests`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getDispute(String(params.disputeId), actor(request)).fix_requests);
  }),

  http.post(`${BASE}/disputes/:disputeId/fix-requests`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string }>(request);
    return run(() => requestFix(String(params.disputeId), actor(request), { comment: input.comment ?? '' }), 201);
  }),

  http.post(`${BASE}/disputes/:disputeId/fix-requests/:fixRequestId/resubmit`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string }>(request);
    return run(() =>
      resubmitFix(String(params.disputeId), String(params.fixRequestId), actor(request), { comment: input.comment ?? '' }),
    );
  }),

  http.post(`${BASE}/disputes/:disputeId/discount-proposal`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ new_amount?: string; currency?: string; anti_waiver_note?: string; reason?: string }>(request);
    return run(
      () =>
        proposeDiscount(String(params.disputeId), actor(request), {
          new_amount: input.new_amount ?? '',
          currency: input.currency ?? '',
          anti_waiver_note: input.anti_waiver_note ?? '',
          reason: input.reason ?? '',
        }),
      201,
    );
  }),

  http.post(`${BASE}/disputes/:disputeId/discount-proposals/:agreementId/decline`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => declineDiscount(String(params.disputeId), String(params.agreementId), actor(request)));
  }),

  http.post(`${BASE}/disputes/:disputeId/resolve`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ resolution_type?: DisputeApiResolutionType }>(request);
    if (!input.resolution_type) return problem(422, 'validation_error', 'resolution_type обязателен.');
    return run(() => resolveDispute(String(params.disputeId), actor(request), { resolution_type: input.resolution_type! }));
  }),

  http.get(`${BASE}/dispute-windows`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const activeOnly = (url.searchParams.get('active') ?? 'true').toLowerCase() !== 'false';
    return run(() => listWindows(actor(request), activeOnly));
  }),

  http.post(`${BASE}/dispute-windows/:windowId/contest`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string }>(request);
    return run(() => contestWindow(String(params.windowId), actor(request), { comment: input.comment ?? '' }));
  }),

  // Доказательства ВНУТРИ разногласия (`apps.evidence`, ADR-131: договор
  // берётся из `dispute.contract` — у гарантийного этапа нет).
  http.get(`${BASE}/disputes/:disputeId/evidence`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listDisputeEvidence(String(params.disputeId)));
  }),

  http.post(`${BASE}/disputes/:disputeId/evidence`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const parsed = await parseMultipart(request);
    const file = parsed?.files.file;
    if (!file) return problem(400, 'invalid_request', 'Файл обязателен (multipart, поле file).');
    return run(() => uploadDisputeEvidence(String(params.disputeId), actor(request), file), 201);
  }),

  http.get(`${BASE}/warranty-claims`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listWarrantyClaims(actor(request)));
  }),

  http.get(`${BASE}/contracts/:contractId/warranty-claims`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listContractWarrantyClaims(String(params.contractId)));
  }),

  http.post(`${BASE}/contracts/:contractId/warranty-claims`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ description?: string; evidence?: string[] }>(request);
    return run(
      () =>
        submitWarrantyClaim(String(params.contractId), actor(request), {
          description: input.description ?? '',
          evidence: input.evidence ?? [],
        }),
      201,
    );
  }),

  // Контур устранения по претензии (ADR-133): исполнитель `decline`/
  // `fix-submitted`, заказчик `satisfy`/`contest`; чужой стороне — 403
  // `wrong_dispute_side`, закрытой претензии — 409 `warranty_claim_already_resolved`,
  // «не устранено» вне окна — 409 `warranty_claim_not_awaiting_confirmation`.
  http.post(`${BASE}/warranty-claims/:claimId/decline`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string }>(request);
    return run(() => declineWarrantyClaim(String(params.claimId), actor(request), { comment: input.comment ?? '' }));
  }),

  http.post(`${BASE}/warranty-claims/:claimId/fix-submitted`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string; evidence?: string[] }>(request);
    return run(() =>
      submitWarrantyFix(String(params.claimId), actor(request), { comment: input.comment ?? '', evidence: input.evidence ?? [] }),
    );
  }),

  http.post(`${BASE}/warranty-claims/:claimId/satisfy`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string }>(request);
    return run(() => satisfyWarrantyClaim(String(params.claimId), actor(request), { comment: input.comment ?? '' }));
  }),

  http.post(`${BASE}/warranty-claims/:claimId/contest`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const input = await body<{ comment?: string; evidence?: string[] }>(request);
    return run(() =>
      contestWarrantyFix(String(params.claimId), actor(request), { comment: input.comment ?? '', evidence: input.evidence ?? [] }),
    );
  }),
];
