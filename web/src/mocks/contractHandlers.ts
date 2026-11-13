import { searchCatalog } from '@porukam/core';
import { http, HttpResponse } from 'msw';
import type { RevisionAuthorRole, ContractVersion } from '@porukam/core';
import { db, MockError, primaryLanguage, resolveViewerFields } from './contractsDb';
import { handleDirectory, checklistRecommendations, clientTreeContractTypes, spheres, workTypes, materialCatalog, units } from './catalog';
import {
  createContract as createRealContract,
  createMilestone as createRealMilestone,
  createSignatureRequest as createRealSignatureRequest,
  freezeContract as freezeRealContract,
  getContract as getRealContract,
  listTimeline as listRealTimeline,
  patchContract as patchRealContract,
  rejectContract as rejectRealContract,
  RealMockError,
  sendContract as sendRealContract,
  withdrawContract as withdrawRealContract,
} from './realContractsDb';

/** Реальный контур (Фазы 1/4, docs/adr/ADR-088-contracts-execution-flow-real-contract.md)
 * и этот старый мок-агрегат делят одни и те же URL (реальные пути) — MSW не умеет
 * «передать следующему хендлеру с тем же паттерном». Диспетчер по неймспейсу id
 * (`rc-*` — новый реальный мок, `realContractsDb.ts`) — единственная правка в этом
 * файле ради Фаз 1/4, вся остальная логика ниже НЕ ТРОГАЛАСЬ (обслуживает страницы
 * вне этих фаз — ContractReviewPage/StagePage/AcceptancePage; SigningPage теперь
 * тоже диспетчер, но старая ветка внутри неё — не трогалась). */
function isRealMockId(id: string): boolean {
  return id.startsWith('rc-');
}

async function runReal(fn: () => unknown): Promise<HttpResponse> {
  try {
    return HttpResponse.json(fn() as object);
  } catch (e) {
    if (e instanceof RealMockError) {
      return new HttpResponse(JSON.stringify({ status: e.status, code: e.code, title: e.code, detail: e.message }), {
        status: e.status,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }
    throw e;
  }
}

const BASE = '/v1';

function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/**
 * DEV-16b — если ответ несёт `.version`, пересчитывает `is_cross_language`/`viewer_render`
 * по языку СМОТРЯЩЕГО (Accept-Language текущего запроса), не по языку, сохранённому в
 * сторе на момент заморозки (contractsDb.resolveViewerFields). Duck-typing по наличию
 * `version` — безопасно вызывать для любого payload (`db.stages()`/`db.history()` и т.п.
 * его просто не имеют).
 */
function withViewerRender<T>(result: T, request: Request): T {
  if (!result || typeof result !== 'object' || !('version' in result)) return result;
  const version = (result as { version?: ContractVersion | null }).version;
  if (!version) return result;
  const viewerLang = primaryLanguage(request.headers.get('Accept-Language'));
  const fields = resolveViewerFields(version.id, version.official_language, viewerLang);
  return { ...result, version: { ...version, ...fields } };
}

/** Оборачивает операцию мок-FSM: MockError → problem+json, успех → JSON.
 * `request` — если передан, применяет DEV-16b `withViewerRender` к результату. */
async function run<T>(fn: () => T, request?: Request): Promise<HttpResponse> {
  try {
    const result = fn();
    return HttpResponse.json((request ? withViewerRender(result, request) : result) as object);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.message, e.extra);
    throw e;
  }
}

function role(request: Request): RevisionAuthorRole {
  const r = request.headers.get('X-Mock-Role');
  return r === 'contractor' ? 'contractor' : 'customer';
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json().catch(() => ({}))) as T;
}

function auth(request: Request): HttpResponse | null {
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
    return problem(401, 'unauthorized', 'Нужен вход.');
  }
  return null;
}

export const contractHandlers = [
  // ── Справочники ──
  http.get(`${BASE}/handles`, ({ request }) => {
    const q = new URL(request.url).searchParams.get('q')?.toLowerCase() ?? '';
    const results = handleDirectory.filter(
      (h) => h.handle.toLowerCase().includes(q) || h.display_name.toLowerCase().includes(q),
    );
    return HttpResponse.json({ results });
  }),
  // ADR-094 — типы клиентского дерева для мастера (уточнение кода Продажи/Аренды/Займа).
  http.get(`${BASE}/contract-types`, ({ request }) => {
    const option = new URL(request.url).searchParams.get('client_option');
    const results = option ? clientTreeContractTypes.filter((t) => t.client_option === option) : clientTreeContractTypes;
    return HttpResponse.json({ results });
  }),
  http.get(`${BASE}/checklist-recommendations`, ({ request }) => {
    const q = new URL(request.url).searchParams;
    // DEV-09 §7: параметр называется workType (тип работ); материальный ключ (DEV-06) — наследие,
    // оба берут из одной таблицы категорий-подсказок.
    const key = q.get('workType') ?? q.get('material') ?? 'Прочее';
    return HttpResponse.json({ results: checklistRecommendations[key] ?? checklistRecommendations['Прочее'] });
  }),
  // DEV-09 §3/§7 — сфера/тип работ (SpherePicker), поиском + популярное + «все сферы».
  http.get(`${BASE}/spheres`, ({ request }) => {
    // ADR-097: нечёткий ранжированный поиск — зеркало apps.catalog.search
    // (опечатки, лишние слова), не substring-заглушка.
    const q = new URL(request.url).searchParams.get('q') ?? '';
    const results = searchCatalog(q, spheres);
    // ADR-100: с запросом — ещё и совпавшие типы работ (с именем сферы),
    // чтобы «мебель» предлагала «Сборка шкафа-купе», а не только сферу.
    const work_types = q.trim()
      ? searchCatalog(q, workTypes)
          .slice(0, 8)
          .map((w) => ({ ...w, sphere_name: spheres.find((s) => s.code === w.sphere_code)?.name ?? w.sphere_code }))
      : [];
    return HttpResponse.json({ results, popular: spheres.filter((s) => s.popular), work_types });
  }),
  http.get(`${BASE}/work-types`, ({ request }) => {
    const sphere = new URL(request.url).searchParams.get('sphere');
    const results = sphere ? workTypes.filter((w) => w.sphere_code === sphere) : workTypes;
    return HttpResponse.json({ results });
  }),
  // DEV-09 §4.3 — каталог материалов (MaterialsModal) и единицы измерения (UnitPicker).
  http.get(`${BASE}/material-catalog`, () => HttpResponse.json({ results: materialCatalog })),
  http.get(`${BASE}/units`, () => HttpResponse.json({ results: units })),

  // ── Реквизиты выплат ──
  http.get(`${BASE}/payout-accounts`, ({ request }) => auth(request) ?? HttpResponse.json({ results: db.payoutAccounts() })),
  http.post(`${BASE}/payout-accounts`, async ({ request }) => {
    const a = await auth(request);
    if (a) return a;
    const b = await body<{ kind?: 'sbp' | 'card' | 'account'; masked?: string }>(request);
    return HttpResponse.json(db.addPayoutAccount(b.kind ?? 'sbp', b.masked ?? '•••• 4321'));
  }),

  // ── Договор ──
  http.get(`${BASE}/contracts/:id`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const id = String(params.id);
    // ADR-158: `materials_seen_at` — отметка СВОЕЙ стороны, поэтому карточке
    // нужен смотрящий (тот же X-Acting-Profile, что у списка договоров).
    const actingProfileId = request.headers.get('X-Acting-Profile') ?? undefined;
    return isRealMockId(id) ? runReal(() => getRealContract(id, actingProfileId)) : run(() => db.get(id), request);
  }),
  http.get(`${BASE}/contracts/:id/timeline`, ({ request, params }) => {
    const authErr = auth(request);
    if (authErr) return authErr;
    const id = String(params.id);
    return isRealMockId(id) ? runReal(() => listRealTimeline(id)) : run(() => ({ results: db.get(id).timeline }));
  }),
  http.get(`${BASE}/contracts/:id/stages`, ({ request, params }) => auth(request) ?? run(() => db.stages(String(params.id)))),
  http.get(`${BASE}/contracts/:id/payment-plan`, ({ request, params }) =>
    auth(request) ?? run(() => db.paymentPlan(String(params.id))),
  ),
  http.get(`${BASE}/contracts/:id/history`, ({ request, params }) => auth(request) ?? run(() => db.history(String(params.id)))),
  // DEV-09 §7 — превью собранного документа (шаг «Превью»): черновик и есть превью, отдельной проекции не нужно.
  http.get(`${BASE}/contracts/:id/preview`, ({ request, params }) => auth(request) ?? run(() => db.get(String(params.id)), request)),

  // Реальное тело (my_role/my_acting_as/contract_type_code/…, ADR-088) не
  // пересекается по полям со старым мок-телом — различаем по НАЛИЧИЮ my_role
  // (обязательное поле реального ContractCreateSerializer, старый мок его не знает).
  http.post(`${BASE}/contracts`, async ({ request }) => {
    const a = auth(request);
    if (a) return a;
    const b = await body<Record<string, unknown>>(request);
    if (typeof b.my_role === 'string') {
      return runReal(() => createRealContract(b as unknown as Parameters<typeof createRealContract>[0]));
    }
    return run(() => db.createDraft(b as Parameters<typeof db.createDraft>[0]));
  }),
  http.patch(`${BASE}/contracts/:id`, async ({ request, params }) => {
    const a = auth(request);
    if (a) return a;
    const id = String(params.id);
    if (isRealMockId(id)) {
      const b = await body<Parameters<typeof patchRealContract>[1]>(request);
      return runReal(() => patchRealContract(id, b));
    }
    const b = await body<Parameters<typeof db.patchDraft>[1]>(request);
    return run(() => db.patchDraft(id, b));
  }),

  // ── Дерево этапов ──
  // DEV-09 §4/§7 — замена всего дерева пачкой (StagesBuilder редактирует локально и сохраняет разом).
  http.patch(`${BASE}/contracts/:id/milestones`, async ({ request, params }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('view') !== 'tree') {
      return problem(400, 'unsupported_view', 'Поддерживается только view=tree');
    }
    const b = await body<{ nodes: Parameters<typeof db.replaceMilestoneTree>[1] }>(request);
    return run(() => db.replaceMilestoneTree(String(params.id), b.nodes ?? []));
  }),
  http.post(`${BASE}/contracts/:id/milestones`, async ({ request, params }) => {
    const id = String(params.id);
    if (isRealMockId(id)) {
      const b = await body<Parameters<typeof createRealMilestone>[1]>(request);
      return runReal(() => createRealMilestone(id, b));
    }
    const b = await body<Parameters<typeof db.addMilestone>[1]>(request);
    return run(() => db.addMilestone(id, b));
  }),
  http.patch(`${BASE}/contracts/:id/milestones/:msId`, async ({ request, params }) => {
    const b = await body<Parameters<typeof db.updateMilestone>[2]>(request);
    return run(() => db.updateMilestone(String(params.id), String(params.msId), b));
  }),
  http.delete(`${BASE}/contracts/:id/milestones/:msId`, ({ params }) =>
    run(() => db.removeMilestone(String(params.id), String(params.msId))),
  ),
  http.post(`${BASE}/contracts/:id/milestones/:msId/materials`, async ({ request, params }) => {
    const b = await body<Parameters<typeof db.addMaterial>[2]>(request);
    return run(() => db.addMaterial(String(params.id), String(params.msId), b));
  }),

  // ── Согласование ──
  http.post(`${BASE}/contracts/:id/send`, ({ request, params }) => {
    const id = String(params.id);
    return isRealMockId(id) ? runReal(() => sendRealContract(id)) : run(() => db.send(id, role(request)));
  }),
  // DEV-09 §7 — тот же переход, имя эндпоинта из мастера («Отправить на согласование»).
  http.post(`${BASE}/contracts/:id/send-for-review`, ({ request, params }) => run(() => db.send(String(params.id), role(request)))),
  http.post(`${BASE}/contracts/:id/revisions`, async ({ request, params }) => {
    const b = await body<Omit<Parameters<typeof db.proposeRevision>[1], 'author_role'>>(request);
    return run(() => db.proposeRevision(String(params.id), { ...b, author_role: role(request) }));
  }),
  http.post(`${BASE}/contracts/:id/revisions/accept-all`, async ({ request, params }) => {
    const b = await body<{ confirm_summary?: boolean }>(request);
    return run(() => db.acceptAllRevisions(String(params.id), b.confirm_summary ?? false));
  }),
  // Ф2 (наследие) — одиночный приём/отклонение без выбора варианта (ContractDetailPage NegoPanel).
  http.post(`${BASE}/contracts/:id/revisions/:revId/respond`, async ({ request, params }) => {
    const b = await body<{ action: 'accept' | 'reject' }>(request);
    return run(() => db.respondRevision(String(params.id), String(params.revId), b.action));
  }),
  // ── DEV-10 · Согласование — протокол разногласий ──
  http.post(`${BASE}/contracts/:id/revisions/:revId/accept`, async ({ request, params }) => {
    const b = await body<{ variant_id: string }>(request);
    return run(() => db.acceptRevision(String(params.id), String(params.revId), role(request), b.variant_id));
  }),
  http.post(`${BASE}/contracts/:id/revisions/:revId/reject`, async ({ request, params }) => {
    const b = await body<{ comment?: string }>(request);
    return run(() => db.rejectRevision(String(params.id), String(params.revId), role(request), b.comment));
  }),
  http.post(`${BASE}/contracts/:id/revisions/:revId/counter`, async ({ request, params }) => {
    const b = await body<{ variants: { value: string; note?: string }[]; comment?: string }>(request);
    return run(() => db.counterRevision(String(params.id), String(params.revId), role(request), b.variants, b.comment));
  }),
  http.post(`${BASE}/contracts/:id/revisions/:revId/withdraw`, ({ request, params }) =>
    run(() => db.withdrawRevision(String(params.id), String(params.revId), role(request))),
  ),
  http.post(`${BASE}/contracts/:id/preapproved-alternatives/:altId/apply`, async ({ request, params }) => {
    const b = await body<{ variant_id: string }>(request);
    return run(() => db.applyPreapproved(String(params.id), String(params.altId), b.variant_id));
  }),
  http.post(`${BASE}/contracts/:id/withdraw`, ({ request, params }) => {
    const id = String(params.id);
    return isRealMockId(id) ? runReal(() => withdrawRealContract(id)) : run(() => db.withdraw(id, role(request)));
  }),
  http.post(`${BASE}/contracts/:id/reject`, ({ request, params }) => {
    const id = String(params.id);
    return isRealMockId(id) ? runReal(() => rejectRealContract(id)) : run(() => db.reject(id, role(request)));
  }),

  // ── Заморозка / подписание ──
  http.post(`${BASE}/contracts/:id/payout-account`, async ({ request, params }) => {
    const b = await body<{ account_id: string }>(request);
    return run(() => db.setPayoutAccount(String(params.id), b.account_id));
  }),
  http.post(`${BASE}/contracts/:id/freeze`, ({ request, params }) => {
    const id = String(params.id);
    return isRealMockId(id) ? runReal(() => freezeRealContract(id)) : run(() => db.freeze(id), request);
  }),
  http.post(`${BASE}/contracts/:id/ai-summary-shown`, ({ request, params }) => run(() => db.markAiSummaryShown(String(params.id)), request)),
  http.post(`${BASE}/contracts/:id/signature-requests`, async ({ request, params }) => {
    const id = String(params.id);
    if (isRealMockId(id)) {
      const b = await request.json().catch(() => ({}));
      return runReal(() => createRealSignatureRequest(id, b as Parameters<typeof createRealSignatureRequest>[1]));
    }
    return run(() => db.requestSignature(id), request);
  }),
  http.post(`${BASE}/contracts/:id/sign`, async ({ request, params }) => {
    const b = await body<{ signatory_name?: string }>(request);
    return run(() => db.sign(String(params.id), role(request), { signatoryName: b.signatory_name }), request);
  }),
  http.post(`${BASE}/contracts/:id/decline`, async ({ request, params }) => {
    const b = await body<{ comment?: string }>(request);
    return run(() => db.declineForRevision(String(params.id), role(request), b.comment), request);
  }),
];
