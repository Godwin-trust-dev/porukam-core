import { http, HttpResponse } from 'msw';
import { findDisputeEvidence } from './disputesDb';
import {
  acceptAllRevisions,
  counterRevision,
  createRevision,
  isRealContract,
  decideRevision,
  RealMockError,
  acceptMilestone,
  acceptanceStatus,
  buildTree,
  cancelRealPayment,
  confirmMilestonePayment,
  confirmRealPayment,
  getRealPayment,
  listContractPayments,
  createChecklistItem,
  createMaterial,
  createAmendment,
  deleteDraftAmendment,
  createAmendmentSignatureRequest,
  declineSignatureRequest,
  effectiveTerms,
  freezeAmendment,
  getAmendment,
  listAmendmentSignatories,
  listAmendmentSignatureRequests,
  listAmendmentTimeline,
  listAmendments,
  updateDraftAmendment,
  sendAmendment,
  forwardSignatureRequest,
  gateStatus,
  handOverMaterial,
  getContractVersion,
  getEvidence,
  getMilestone,
  listChecklistItems,
  listContracts,
  listEvidence,
  listMaterials,
  listMilestoneTimeline,
  listPreapproved,
  listRevisions,
  listSignatories,
  listSignatureRequests,
  markMaterialsSeen,
  patchChecklistItem,
  patchMaterial,
  patchMilestone,
  deleteChecklistItem,
  deleteContract,
  deleteMaterial,
  deleteMilestone,
  rejectAmendment,
  rejectMilestone,
  returnForRevision,
  signSignatureRequest,
  receiveMaterial,
  startMilestone,
  submitMilestone,
  uploadEvidence,
  withdrawAmendment,
} from './realContractsDb';
import { formSchemaFor } from './formSchemas';
import { getMe } from './profileDb';
import { parseMultipart } from './multipart';

const BASE = '/v1';

/** Доказательство по id для `GET /evidence/{id}/thumbnail|download`: реестр
 * договоров знает только файлы этапов, а тот же эндпоинт отдаёт и файлы,
 * приложенные ВНУТРИ разногласия (`POST /disputes/{id}/evidence`) — без этого
 * фолбэка вложения в ленте спора не открывались и не скачивались. */
/** 8×8 PNG сплошной заливкой — минимальный ДЕКОДИРУЕМЫЙ файл для превью. */
const MOCK_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR42mNkYPhfz0AEYBxVSF+FjAxUAgClHwSBIGDgWQAAAABJRU5ErkJggg==';
function MOCK_IMAGE_BYTES(): Uint8Array {
  const binary = atob(MOCK_IMAGE_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function findEvidence(evidenceId: string) {
  return findDisputeEvidence(evidenceId) ?? getEvidence(evidenceId);
}

/** Актёр протокола разногласий — X-Acting-Profile с фолбэком основной персоны сидов. */
function actor(request: Request): string {
  return request.headers.get('X-Acting-Profile') ?? 'pf-person-1';
}

function problem(status: number, code: string, detail: string, context?: Record<string, unknown>) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail, ...(context ? { context } : {}) }), {
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

async function run(fn: () => unknown, status = 200): Promise<HttpResponse> {
  try {
    return HttpResponse.json(fn() as object, { status });
  } catch (e) {
    if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
    throw e;
  }
}

/**
 * Мок-хендлеры РЕАЛЬНОГО контура сделки (Фаза 1, docs/adr/
 * ADR-088-contracts-execution-flow-real-contract.md) — зеркалят реальные
 * пути `apps.contracts`/`apps.milestones`.
 *
 * ⚠ `GET /contracts/{id}` и другие id-параметризованные пути ЗДЕСЬ НЕ
 * зарегистрированы — та же URL уже занята `contractHandlers.ts` (старый
 * мок-агрегат, всё ещё обслуживает ContractReviewPage/SigningPage/
 * StagePage/AcceptancePage вне этой фазы). Диспетчер по неймспейсу id
 * (`rc-*`) — в `contractHandlers.ts` (единственная правка того файла ради
 * Фазы 1, см. комментарий там). Здесь — только пути, которых СТАРЫЙ мок
 * либо не знает вовсе (GET revisions/preapproved/signature-requests —
 * тот умеет только POST на этих путях), либо они не id-параметризованы
 * так же (`/milestones/{id}` — ПЛОСКИЙ путь, старый мок нигде не
 * регистрирует, только вложенный `/contracts/{id}/milestones/{msId}`).
 */
export const realContractsHandlers = [
  http.get(`${BASE}/contracts`, ({ request }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    return HttpResponse.json(
      listContracts({
        role: url.searchParams.get('role') ?? undefined,
        negotiation_status: url.searchParams.get('negotiation_status') ?? undefined,
        segment: url.searchParams.get('segment') ?? undefined,
        // `list_my_contracts` (apps.contracts.selectors) всегда скоупит на владельца
        // через X-Acting-Profile — не публичный список, ADR-088.
        actingProfileId: request.headers.get('X-Acting-Profile') ?? undefined,
      }),
    );
  }),

  // GET (дерево, `apps.milestones.selectors.build_tree`) — старый мок этот путь
  // вообще не регистрирует (агрегат отдаёт milestones частью самого контракта),
  // коллизии нет.
  // ADR-104 + отсмотр 2026-08-21: удаление черновика в реальном контуре
  // (DELETE → 204). Раньше мок был только у старого агрегата (contractsDb),
  // и «Удалить черновик» в mock-режиме отвечал 404.
  http.delete(`${BASE}/contracts/:id`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const id = String(params.id);
    if (!id.startsWith('rc-')) return undefined; // старый агрегат — contractsListHandlers
    try {
      deleteContract(id);
      return new HttpResponse(null, { status: 204 });
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
  }),
  http.get(`${BASE}/contracts/:id/milestones`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => buildTree(String(params.id)));
  }),

  http.patch(`${BASE}/milestones/:milestoneId`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => patchMilestone(String(params.milestoneId), body as Parameters<typeof patchMilestone>[1]));
  }),

  http.delete(`${BASE}/milestones/:milestoneId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    try {
      deleteMilestone(String(params.milestoneId));
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${BASE}/milestones/:milestoneId/checklist-items`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listChecklistItems(String(params.milestoneId)));
  }),
  http.post(`${BASE}/milestones/:milestoneId/checklist-items`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => createChecklistItem(String(params.milestoneId), body as Parameters<typeof createChecklistItem>[1]));
  }),
  // Правка/удаление пункта чек-листа до подписания (отсмотр 2026-08-25:
  // мастер редактирует критерии и после сохранения этапа) — плоские пути,
  // как `/milestones/{id}`; старый мок-агрегат их не регистрирует.
  http.patch(`${BASE}/checklist-items/:itemId`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => patchChecklistItem(String(params.itemId), body as Parameters<typeof patchChecklistItem>[1]));
  }),
  http.delete(`${BASE}/checklist-items/:itemId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    try {
      deleteChecklistItem(String(params.itemId));
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message);
      throw e;
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // Материалы этапа (решение владельца 03.09 — мастер снова их заводит).
  // `PATCH`/`DELETE /materials/{id}` — плоские пути по образцу
  // `/checklist-items/{id}`; на реальном бэке их ЕЩЁ НЕТ (там только
  // `GET/POST /milestones/{id}/materials`) — мок отвечает ими заранее.
  http.get(`${BASE}/milestones/:milestoneId/materials`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listMaterials(String(params.milestoneId)));
  }),
  http.post(`${BASE}/milestones/:milestoneId/materials`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => createMaterial(String(params.milestoneId), body as Parameters<typeof createMaterial>[1], actor(request)), 201);
  }),
  http.patch(`${BASE}/materials/:materialId`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => patchMaterial(String(params.materialId), body as Parameters<typeof patchMaterial>[1], actor(request)));
  }),
  http.delete(`${BASE}/materials/:materialId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    try {
      deleteMaterial(String(params.materialId), actor(request));
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message);
      throw e;
    }
    return new HttpResponse(null, { status: 204 });
  }),
  // ADR-155 §6: два факта двух РАЗНЫХ сторон — «передал» отмечает сторона-
  // источник, «получил» другая (403 `material_handover_wrong_side`). Порядок
  // между шагами не обязателен: получение можно отметить и без передачи.
  http.post(`${BASE}/materials/:materialId/handed-over`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => handOverMaterial(String(params.materialId), actor(request)));
  }),
  http.post(`${BASE}/materials/:materialId/received`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => receiveMaterial(String(params.materialId), actor(request)));
  }),

  // ── ADR-088 Фаза 5 (этапы: сдача + реальная multipart-загрузка evidence) —
  // все пути ниже ПЛОСКИЕ (`/milestones/{id}/...`), старый мок-агрегат их не
  // регистрирует (тот знает только вложенный `/contracts/{id}/stages/{sid}/...`,
  // `stageExecutionHandlers.ts`) — коллизий нет, диспетчер по неймспейсу
  // здесь не нужен.
  http.get(`${BASE}/milestones/:milestoneId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getMilestone(String(params.milestoneId)));
  }),
  http.get(`${BASE}/milestones/:milestoneId/gate`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => gateStatus(String(params.milestoneId)));
  }),
  http.get(`${BASE}/milestones/:milestoneId/timeline`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listMilestoneTimeline(String(params.milestoneId)));
  }),
  http.get(`${BASE}/milestones/:milestoneId/acceptance`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => acceptanceStatus(String(params.milestoneId)));
  }),
  http.post(`${BASE}/milestones/:milestoneId/start`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => startMilestone(String(params.milestoneId), getMe().id));
  }),
  http.post(`${BASE}/milestones/:milestoneId/submit`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => submitMilestone(String(params.milestoneId), body as Parameters<typeof submitMilestone>[1], getMe().id));
  }),
  // ADR-088 Фаза 6 (приёмка) — плоские, коллизий со старым мок-агрегатом
  // (`/contracts/{id}/milestones/{id}/accept`, `AcceptancePage.tsx`) нет.
  http.post(`${BASE}/milestones/:milestoneId/accept`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => acceptMilestone(String(params.milestoneId), getMe().id));
  }),
  http.post(`${BASE}/milestones/:milestoneId/reject`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { checklist_item_id?: string | null; evidence?: string[] };
    return run(() => rejectMilestone(String(params.milestoneId), body.checklist_item_id, body.evidence ?? [], getMe().id));
  }),
  // Ф4-gap (qa-backlog 2026-08-20): подтверждение оплаты cash/external —
  // роль вызывающего в моке определяется по X-Acting-Profile (см. докстринг
  // `confirmMilestonePayment` — у мока один токен, актёр и есть «кто действует»).
  http.post(`${BASE}/milestones/:milestoneId/confirm-payment`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { side?: 'customer' | 'contractor' };
    if (body.side !== 'customer' && body.side !== 'contractor') {
      return problem(400, 'invalid_request', 'side: допустимо только customer или contractor.');
    }
    const acting = request.headers.get('X-Acting-Profile') ?? undefined;
    return run(() => confirmMilestonePayment(String(params.milestoneId), body.side as 'customer' | 'contractor', acting, getMe().id));
  }),

  // ── Платёжный контур Э5 (ADR-130) ───────────────────────────────────────
  //
  // `GET /payments/{id}` и `POST /payments/{id}/confirm` заняты СТАРЫМ
  // мок-контуром (`paymentHandlers.ts`, эквайринг/СБП, id `pay-*`) — тот
  // обслуживает PaymentPage вне этой волны. Разводим неймспейсом id:
  // `undefined` из хендлера возвращает запрос следующему совпавшему, ровно
  // тот же приём, что у `DELETE /contracts/:id` выше.
  http.get(`${BASE}/contracts/:id/payments`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const id = String(params.id);
    if (!id.startsWith('rc-')) return undefined;
    return run(() => listContractPayments(id, actor(request)));
  }),
  http.get(`${BASE}/payments/:paymentId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const id = String(params.paymentId);
    if (!id.startsWith('rpay-')) return undefined;
    return run(() => getRealPayment(id, actor(request)));
  }),
  // Idempotency-Key на НОВЫХ денежных POST ОБЯЗАТЕЛЕН (ADR-130 §2: 400
  // `idempotency_key_required` без него) — в отличие от унаследованных
  // `/milestones/{id}/confirm-*`, где он honoured, но не обязателен.
  // Проверяем и в моке: иначе забытый флаг `idempotent` на клиенте всплыл бы
  // только на реальном бэке.
  http.post(`${BASE}/payments/:paymentId/confirm`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const id = String(params.paymentId);
    if (!id.startsWith('rpay-')) return undefined;
    if (!request.headers.get('Idempotency-Key')) {
      return problem(400, 'idempotency_key_required', 'Заголовок Idempotency-Key обязателен.');
    }
    const body = (await request.json().catch(() => ({}))) as { side?: 'payer' | 'payee' };
    return run(() => confirmRealPayment(id, body.side, actor(request)));
  }),
  http.post(`${BASE}/payments/:paymentId/cancel`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const id = String(params.paymentId);
    if (!id.startsWith('rpay-')) return undefined;
    if (!request.headers.get('Idempotency-Key')) {
      return problem(400, 'idempotency_key_required', 'Заголовок Idempotency-Key обязателен.');
    }
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    return run(() => cancelRealPayment(id, body.reason ?? '', actor(request)));
  }),

  http.get(`${BASE}/milestones/:milestoneId/evidence`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listEvidence(String(params.milestoneId)));
  }),
  // РЕАЛЬНЫЙ multipart и в моке — `file` шлётся настоящими байтами, не
  // JSON-метаданными (ADR-088 Фаза 5, ГВ.3). `parseMultipart` (`./multipart.ts`)
  // вместо `Request.formData()` — обходит jsdom-тестовый разъезд классов
  // `File`, см. докстринг того файла; реального бэка не касается.
  http.post(`${BASE}/milestones/:milestoneId/evidence`, async ({ request, params }) => {
    try {
      const authErr = auth(request);
      if (authErr) return authErr;
      const parsed = await parseMultipart(request);
      const file = parsed?.files.file;
      if (!file) return problem(400, 'invalid_request', 'Файл обязателен (multipart, поле file).');
      const checklistItemId = parsed?.fields.checklist_item_id;
      const evidence = uploadEvidence(String(params.milestoneId), file, checklistItemId, getMe().id, parsed?.fields.description);
      return HttpResponse.json(evidence, { status: 201 });
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
  }),
  // `EvidenceThumbnailView` докстринг: 404 честно — миниатюра встроена не у
  // каждого файла, мок её никогда не считает (нет реального EXIF-пайплайна) —
  // `RealStagePage.onViewEvidence` уже трактует 404 как «нет превью», не ошибку.
  http.get(`${BASE}/evidence/:evidenceId/thumbnail`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    try {
      findEvidence(String(params.evidenceId));
      return problem(404, 'thumbnail_not_available', 'У этого файла нет встроенной миниатюры.');
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
  }),

  // Оригинал доказательства — байты как есть. Для картинок мок отдаёт
  // НАСТОЯЩИЙ (пусть и крошечный) PNG: просмотрщик спора показывает оригинал,
  // и на текстовой заглушке с `Content-Type: image/*` он рисовал бы значок
  // сломанной картинки вместо фото.
  http.get(`${BASE}/evidence/:evidenceId/download`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    try {
      const ev = findEvidence(String(params.evidenceId));
      if (ev.mime_type.startsWith('image/')) {
        return new HttpResponse(MOCK_IMAGE_BYTES(), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      return new HttpResponse(`mock-bytes:${ev.file_name}`, { status: 200, headers: { 'Content-Type': ev.mime_type } });
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message);
      throw e;
    }
  }),

  // ADR-123: схема формы типа — для списка полей в правке (услуга; аренда/займ
  // тесты мастера подменяют точечно).
  http.get(`${BASE}/contract-types/:code/form-schema`, ({ params }) => {
    const schema = formSchemaFor(String(params.code));
    return schema ? HttpResponse.json(schema) : problem(404, 'not_found', 'У типа нет схемы формы.');
  }),
  http.get(`${BASE}/contracts/:id/revisions`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listRevisions(String(params.id)));
  }),
  // Протокол разногласий (реальные пути, fix/web-revisions-real-api).
  http.post(`${BASE}/contracts/:id/revisions`, async ({ request, params }) => {
    // Путь общий со старым мок-слоем (contractHandlers, договоры c-3001/c-6001).
    // `undefined` = «этот хендлер не отвечает», MSW идёт к следующему совпавшему;
    // без этого legacy-договоры получали 404 и экран согласования в мок-режиме
    // молча переставал работать (e2e contract-flow/review ловили именно это).
    if (!isRealContract(String(params.id))) return undefined;
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json()) as { item_ref: string; new_value: unknown; old_value?: unknown; comment?: string };
    return run(() => createRevision(String(params.id), body, actor(request)));
  }),
  http.post(`${BASE}/contracts/:id/revisions/accept-all`, async ({ request, params }) => {
    if (!isRealContract(String(params.id))) return undefined; // см. комментарий выше
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { confirm_summary?: boolean };
    try {
      return HttpResponse.json(acceptAllRevisions(String(params.id), body.confirm_summary ?? false, actor(request)));
    } catch (e) {
      if (e instanceof RealMockError && e.code === 'confirm_summary_required') {
        // Зеркало DomainAPIError: сводка «было -> стало» — в context.summary.
        const summary = listRevisions(String(params.id))
          .filter((r) => r.status === 'open' && r.proposed_by_id !== actor(request))
          .map((r) => ({ item_ref: r.item_ref, old_value: r.old_value, new_value: r.new_value }));
        return new HttpResponse(
          JSON.stringify({ status: 422, code: e.code, title: e.code, detail: e.message, context: { summary } }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
  }),
  http.post(`${BASE}/revisions/:revId/accept`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => decideRevision(String(params.revId), 'accepted', actor(request)));
  }),
  http.post(`${BASE}/revisions/:revId/reject`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => decideRevision(String(params.revId), 'rejected', actor(request)));
  }),
  http.post(`${BASE}/revisions/:revId/counter`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json()) as { new_value: unknown; comment?: string };
    return run(() => counterRevision(String(params.revId), body, actor(request)));
  }),
  http.get(`${BASE}/contracts/:id/preapproved-alternatives`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listPreapproved(String(params.id)));
  }),
  http.get(`${BASE}/contracts/:id/signature-requests`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listSignatureRequests(String(params.id)));
  }),
  // ADR-158: «материалы этапов просмотрены моей стороной». Идемпотентно —
  // отметка монотонна и зажата «сейчас», как на бэке.
  http.post(`${BASE}/contracts/:id/materials-seen`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { seen_at?: string | null };
    return run(() => markMaterialsSeen(String(params.id), actor(request), body.seen_at ?? null));
  }),
  // ADR-124: возврат на доработку с этапа подписания любой стороной, без
  // заявки на подпись. Старый мок-агрегат этот путь не знает — коллизии нет.
  http.post(`${BASE}/contracts/:id/return-for-revision`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => returnForRevision(String(params.id), body as Parameters<typeof returnForRevision>[1]));
  }),

  // ── Фаза 4 (заморозка + подписание, ADR-088) — POST /contracts/:id/freeze
  // и POST /contracts/:id/signature-requests коллизируют со старым мок-
  // агрегатом (тот их тоже регистрирует, contractHandlers.ts) — диспетчер там,
  // как остальные 8 коллизионных путей. Здесь — только некоризирующие:
  // GET версии/подписантов, `/signature-requests/{id}/...` (свой URL-корень,
  // старый мок этих путей не знает вовсе).
  http.get(`${BASE}/contracts/:id/versions/:versionId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getContractVersion(String(params.id), String(params.versionId)));
  }),
  http.get(`${BASE}/contracts/:id/signatories`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const side = url.searchParams.get('side');
    if (side !== 'customer' && side !== 'contractor') return problem(400, 'invalid_request', 'Параметр side обязателен: customer или contractor');
    return run(() => listSignatories(String(params.id), side));
  }),
  http.post(`${BASE}/signature-requests/:signatureRequestId/sign`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => signSignatureRequest(String(params.signatureRequestId), body as Parameters<typeof signSignatureRequest>[1], getMe().id));
  }),
  http.post(`${BASE}/signature-requests/:signatureRequestId/forward`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => forwardSignatureRequest(String(params.signatureRequestId), body as Parameters<typeof forwardSignatureRequest>[1], getMe().id));
  }),
  http.post(`${BASE}/signature-requests/:signatureRequestId/decline`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => declineSignatureRequest(String(params.signatureRequestId), body as Parameters<typeof declineSignatureRequest>[1], getMe().id));
  }),

  // ── Э4.5: допники (tech-spec.md §8.6) — свой URL-корень `/amendments/{id}`,
  // старый мок-агрегат этих путей не знает; `/contracts/:id/amendments` и
  // `/contracts/:id/effective-terms` — тоже только здесь.
  http.get(`${BASE}/contracts/:id/amendments`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listAmendments(String(params.id), getMe().id));
  }),
  http.post(`${BASE}/contracts/:id/amendments`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    try {
      return HttpResponse.json(createAmendment(String(params.id), body as Parameters<typeof createAmendment>[1], getMe().id), { status: 201 });
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
  }),
  http.get(`${BASE}/contracts/:id/effective-terms`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => effectiveTerms(String(params.id)));
  }),
  http.get(`${BASE}/amendments/:amendmentId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => getAmendment(String(params.amendmentId), getMe().id));
  }),
  // ADR-161 §2: правка и удаление ЧЕРНОВИКА допника — только инициатором.
  http.patch(`${BASE}/amendments/:amendmentId`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    return run(() => updateDraftAmendment(String(params.amendmentId), body as Parameters<typeof updateDraftAmendment>[1], getMe().id));
  }),
  http.delete(`${BASE}/amendments/:amendmentId`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    try {
      deleteDraftAmendment(String(params.amendmentId), getMe().id);
      return new HttpResponse(null, { status: 204 });
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
  }),
  http.post(`${BASE}/amendments/:amendmentId/send`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => sendAmendment(String(params.amendmentId)));
  }),
  http.post(`${BASE}/amendments/:amendmentId/freeze`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => freezeAmendment(String(params.amendmentId)));
  }),
  http.get(`${BASE}/amendments/:amendmentId/signatories`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const side = new URL(request.url).searchParams.get('side');
    if (side !== 'customer' && side !== 'contractor') return problem(400, 'invalid_request', 'Параметр side обязателен: customer или contractor');
    return run(() => listAmendmentSignatories(String(params.amendmentId), side));
  }),
  http.get(`${BASE}/amendments/:amendmentId/signature-requests`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listAmendmentSignatureRequests(String(params.amendmentId)));
  }),
  http.post(`${BASE}/amendments/:amendmentId/signature-requests`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    try {
      return HttpResponse.json(createAmendmentSignatureRequest(String(params.amendmentId), body as Parameters<typeof createAmendmentSignatureRequest>[1]), { status: 201 });
    } catch (e) {
      if (e instanceof RealMockError) return problem(e.status, e.code, e.message, e.context);
      throw e;
    }
  }),
  // Отзыв/отклонение допника — общая `NEGOTIATION_FSM` договора; актёр —
  // залогиненный ПОЛЬЗОВАТЕЛЬ (`created_by_id` — id пользователя, не профиля).
  http.post(`${BASE}/amendments/:amendmentId/withdraw`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    return run(() => withdrawAmendment(String(params.amendmentId), { reason: body.reason }, getMe().id));
  }),
  http.post(`${BASE}/amendments/:amendmentId/reject`, async ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    return run(() => rejectAmendment(String(params.amendmentId), { reason: body.reason }, getMe().id));
  }),
  http.get(`${BASE}/amendments/:amendmentId/timeline`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    return run(() => listAmendmentTimeline(String(params.amendmentId)));
  }),
];
