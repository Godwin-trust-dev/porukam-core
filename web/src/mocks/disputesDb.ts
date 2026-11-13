/**
 * Мок-стор контура разногласий и гарантии (этап 7 бэкенда, ADR-131) —
 * зеркало `apps.disputes` + `apps.warranty`, а не заглушка: FSM
 * (`open` → `awaiting_fix` → `open` → `awaiting_discount` → `resolved`),
 * потолок двух раундов исправления, окна оспаривания и коды ошибок §8.8
 * воспроизводятся ровно так, как ответит Django (web/CLAUDE.md §3).
 *
 * Стороны и суммы берём из `realContractsDb` — второго источника правды о
 * договорах в моке нет; имя контрагента — из `profilesDb` (тот же реестр, что
 * отдаёт `GET /profiles/{id}`, ровно как `public_display_name` на бэке).
 */
import type {
  DiscountAgreement,
  Dispute,
  DisputeApiResolutionType,
  DisputeReply,
  DisputeStatus,
  DisputeWindow,
  FixRequest,
  RealEvidence,
  WarrantyClaim,
  WarrantyFix,
} from '@porukam/core';
import { createDiscountAmendment, getContract, getMilestone, subscribeAmendmentEvents } from './realContractsDb';
import { getProfileSettings } from './profilesDb';
import { isDemoStore } from './demoEn';

export class DisputeMockError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

/** Потолок раундов исправления — константа кода и на бэке
 * (`apps.disputes.models.MAX_FIX_ROUNDS`), плюс CHECK в схеме. Раунды
 * устранения по гарантийной претензии — тот же потолок (ADR-133). */
const MAX_FIX_ROUNDS = 2;

/** Окно подтверждения устранения заказчиком — ТОЙ ЖЕ длины, что окно
 * приёмки этапа (ADR-133; `ACCEPTANCE_WINDOW_DAYS` в `stageExecutionDb`). */
const WARRANTY_CONFIRM_WINDOW_DAYS = 5;

/** Профиль → пользователь: `opened_by_id`/`proposed_by_id` на бэке это id
 * ПОЛЬЗОВАТЕЛЯ, не профиля (та же карта, что в `realContractsDb`). */
const OWNER_USER_ID: Record<string, string> = {
  'pf-person-1': 'u-1001',
  'pf-mock-contractor-1': 'u-2001',
};

function userIdOf(profileId: string): string {
  return OWNER_USER_ID[profileId] ?? `u-${profileId}`;
}

interface DisputeRecord extends Dispute {
  /** Профили сторон — мок считает `counterparty` относительно читателя так же,
   * как `selectors.counterparty_snapshot`. */
  partyProfileIds: string[];
  replies: DisputeReply[];
}

/** Заявка с контуром устранения (ADR-133) — поля, которые в типе API
 * необязательны (ответы старого бэка), в моке всегда есть. Окно
 * подтверждения на бэке — `DomainDeadline` (не `DisputeWindow`), поэтому в
 * `/dispute-windows` его нет: виджет дашборда собирает его из претензий. */
interface ClaimRecord extends WarrantyClaim {
  fixes: WarrantyFix[];
  fix_rounds_used: number;
  fix_rounds_left: number;
  fix_submitted_at: string | null;
  acceptance_deadline_at: string | null;
}

const disputes = new Map<string, DisputeRecord>();
const windows = new Map<string, DisputeWindow>();
const claims = new Map<string, ClaimRecord>();
const disputeEvidence = new Map<string, RealEvidence[]>();
let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

function iso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 3600 * 1000).toISOString();
}

function daysToCap(d: Dispute): number | null {
  if (d.cap_deadline_at === null || d.status === 'resolved') return null;
  return Math.max(Math.floor((Date.parse(d.cap_deadline_at) - Date.now()) / (24 * 3600 * 1000)), 0);
}

function makeWindow(partial: Partial<DisputeWindow> & Pick<DisputeWindow, 'id' | 'kind' | 'contract_id'>): DisputeWindow {
  return {
    dispute_id: null,
    subject_ref: {},
    opened_at: iso(-1),
    deadline_at: iso(6),
    contested: null,
    contested_by_id: null,
    contested_at: null,
    closed_at: null,
    ...partial,
  };
}

function makeDispute(partial: Partial<DisputeRecord> & Pick<DisputeRecord, 'id' | 'contract_id' | 'partyProfileIds'>): DisputeRecord {
  return {
    kind: 'milestone',
    milestone_id: null,
    checklist_item_id: null,
    opened_by_id: 'u-2001',
    counterparty: null,
    evidence: [],
    status: 'open',
    fix_rounds_used: 0,
    fix_rounds_left: MAX_FIX_ROUNDS,
    resolution_type: '',
    outcome: '',
    opened_at: iso(-8),
    cap_deadline_at: iso(22),
    days_to_cap: 22,
    resolved_at: null,
    fix_requests: [],
    discount_agreements: [],
    windows: [],
    replies: [],
    ...partial,
  };
}

function makeClaim(partial: Partial<ClaimRecord> & Pick<ClaimRecord, 'id' | 'contract_id' | 'submitted_by_id' | 'description' | 'submitted_at'>): ClaimRecord {
  return {
    evidence: [],
    status: 'submitted',
    resolution_type: '',
    dispute_id: null,
    resolved_at: null,
    fixes: [],
    fix_rounds_used: 0,
    fix_rounds_left: MAX_FIX_ROUNDS,
    fix_submitted_at: null,
    acceptance_deadline_at: null,
    ...partial,
  };
}

/** Сид-доказательство разногласия: у `Dispute.evidence` в ответе бэка одни
 * идентификаторы, метаданные (имя, тип, размер) карточка берёт из
 * `GET /disputes/{id}/evidence` — без сида плитки вложений в ленте были бы
 * безымянными. */
function seedEvidence(
  disputeId: string,
  contractId: string,
  items: { id: string; file_name: string; mime_type: string; uploaded_by_id: string; created_at: string; description?: string }[],
): void {
  disputeEvidence.set(
    disputeId,
    items.map((it) => ({
      id: it.id,
      contract_id: contractId,
      milestone_id: null,
      checklist_item_id: null,
      dispute_id: disputeId,
      uploaded_by_id: it.uploaded_by_id,
      file_name: it.file_name,
      description: it.description ?? '',
      mime_type: it.mime_type,
      file_size: 1024 * 512,
      file_hash: it.id.padEnd(64, '0').slice(0, 64),
      trusted_timestamp_at: it.created_at,
      trusted_timestamp_source: 'mock-tsa',
      has_thumbnail: false,
      metadata: {},
      storage_mode: 'ru',
      delivery_status: 'delivered',
      delivered_to_counterparty_at: it.created_at,
      backup_status: 'not_requested',
      backup_provider: '',
      backup_completed_at: null,
      backup_failure_reason: '',
      backup_drive_file_id: '',
      backup_drive_web_view_link: '',
      created_at: it.created_at,
    })),
  );
}

function seed(): void {
  disputes.clear();
  windows.clear();
  claims.clear();
  disputeEvidence.clear();
  seq = 0;

  // (1) открытое разногласие по этапу — заказчик `pf-mock-contractor-1`
  // отклонил «Стяжку пола» у исполнителя `pf-person-1` (те же роли, что в
  // сиде rc-progress-1). Активное окно ответа тикает.
  const responseWindow = makeWindow({
    id: 'dw-open-1',
    kind: 'dispute_response',
    contract_id: 'rc-progress-1',
    dispute_id: 'dsp-open-1',
    subject_ref: { type: 'dispute', id: 'dsp-open-1' },
  });
  windows.set(responseWindow.id, responseWindow);
  disputes.set(
    'dsp-open-1',
    makeDispute({
      id: 'dsp-open-1',
      contract_id: 'rc-progress-1',
      milestone_id: 'ms-3-disputed',
      checklist_item_id: 'ci-ms3-1',
      opened_by_id: 'u-2001',
      partyProfileIds: ['pf-mock-contractor-1', 'pf-person-1'],
      evidence: ['ev-seed-1'],
      windows: [responseWindow],
    }),
  );

  // (2) ждёт исправления — раунд 1 запрошен, ещё не сдан.
  disputes.set(
    'dsp-fix-1',
    makeDispute({
      id: 'dsp-fix-1',
      contract_id: 'rc-progress-1',
      milestone_id: 'ms-3-under-acceptance',
      checklist_item_id: 'ci-ms3-1',
      opened_by_id: 'u-2001',
      partyProfileIds: ['pf-mock-contractor-1', 'pf-person-1'],
      status: 'awaiting_fix',
      fix_rounds_used: 1,
      fix_rounds_left: 1,
      fix_requests: [
        {
          id: 'fr-1',
          round: 1,
          requested_by_id: 'u-2001',
          comment: 'Швы у порога разошлись — переделайте стык.',
          requested_at: iso(-2),
          resubmitted_by_id: null,
          resubmit_comment: '',
          resubmitted_at: null,
        },
      ],
    }),
  );

  // (3) оба раунда израсходованы — «Запросить исправление» гаснет с пояснением.
  disputes.set(
    'dsp-fix-2of2',
    makeDispute({
      id: 'dsp-fix-2of2',
      contract_id: 'rc-progress-1',
      milestone_id: 'ms-3',
      checklist_item_id: 'ci-ms3-1',
      opened_by_id: 'u-1001',
      partyProfileIds: ['pf-mock-contractor-1', 'pf-person-1'],
      status: 'open',
      fix_rounds_used: 2,
      fix_rounds_left: 0,
      fix_requests: [
        {
          id: 'fr-2',
          round: 1,
          requested_by_id: 'u-1001',
          comment: 'Затирка неровная.',
          requested_at: iso(-6),
          resubmitted_by_id: 'u-2001',
          resubmit_comment: 'Перетёрли швы.',
          resubmitted_at: iso(-5),
        },
        {
          id: 'fr-3',
          round: 2,
          requested_by_id: 'u-1001',
          comment: 'Осталась полоса у окна.',
          requested_at: iso(-4),
          resubmitted_by_id: 'u-2001',
          resubmit_comment: 'Полосу убрали.',
          resubmitted_at: iso(-3),
        },
      ],
    }),
  );

  // (4) предложена скидка — ждёт решения второй стороны (`amendment_id` ведёт
  // в общий контур подписания допника).
  disputes.set(
    'dsp-discount-1',
    makeDispute({
      id: 'dsp-discount-1',
      contract_id: 'rc-progress-1',
      milestone_id: 'ms-3',
      checklist_item_id: 'ci-ms3-1',
      opened_by_id: 'u-2001',
      partyProfileIds: ['pf-mock-contractor-1', 'pf-person-1'],
      status: 'awaiting_discount',
      discount_agreements: [
        {
          id: 'da-1',
          amendment_id: 'am-seed-1',
          milestone_id: 'ms-3',
          proposed_by_id: 'u-2001',
          old_amount: '45000.00',
          old_amount_currency: 'RUB',
          new_amount: '40000.00',
          new_amount_currency: 'RUB',
          anti_waiver_note: 'Скидка закрывает только полосу затирки у окна и не снимает прочих требований.',
          status: 'proposed',
          decided_by_id: null,
          decided_at: null,
          created_at: iso(-1),
        },
      ],
    }),
  );

  // (5) закрытое разногласие — исход по согласию сторон.
  disputes.set(
    'dsp-resolved-1',
    makeDispute({
      id: 'dsp-resolved-1',
      contract_id: 'rc-progress-1',
      milestone_id: 'ms-3-accepted',
      checklist_item_id: 'ci-ms3-1',
      opened_by_id: 'u-2001',
      partyProfileIds: ['pf-mock-contractor-1', 'pf-person-1'],
      status: 'resolved',
      resolution_type: 'accepted',
      outcome: 'resolved',
      opened_at: iso(-20),
      cap_deadline_at: iso(10),
      days_to_cap: null,
      resolved_at: iso(-18),
    }),
  );

  // (6) гарантийное разногласие + заявка (rc-warranty-1, Годвин заказчик).
  disputes.set(
    'dsp-warranty-1',
    makeDispute({
      id: 'dsp-warranty-1',
      contract_id: 'rc-warranty-1',
      kind: 'warranty',
      milestone_id: null,
      checklist_item_id: null,
      opened_by_id: 'u-1001',
      partyProfileIds: ['pf-person-1', 'pf-mock-contractor-1'],
      evidence: ['ev-seed-2'],
      opened_at: iso(-3),
      cap_deadline_at: iso(27),
      days_to_cap: 27,
    }),
  );
  claims.set(
    'wc-1',
    makeClaim({
      id: 'wc-1',
      contract_id: 'rc-warranty-1',
      submitted_by_id: 'u-1001',
      description: 'Ламинат у балконной двери вздулся на стыке.',
      evidence: ['ev-seed-2'],
      dispute_id: 'dsp-warranty-1',
      submitted_at: iso(-3),
    }),
  );

  // (6b) претензия, по которой исполнитель уже сообщил «устранил» (ADR-133):
  // у Годвина-заказчика тикает окно подтверждения — строка на дашборде
  // (собирается из претензий, окна в `/dispute-windows` нет).
  disputes.set(
    'dsp-warranty-fix-1',
    makeDispute({
      id: 'dsp-warranty-fix-1',
      contract_id: 'rc-warranty-1',
      kind: 'warranty',
      milestone_id: null,
      checklist_item_id: null,
      opened_by_id: 'u-1001',
      partyProfileIds: ['pf-person-1', 'pf-mock-contractor-1'],
      evidence: ['ev-seed-3'],
      opened_at: iso(-6),
      cap_deadline_at: iso(24),
      days_to_cap: 24,
    }),
  );
  claims.set(
    'wc-2',
    makeClaim({
      id: 'wc-2',
      contract_id: 'rc-warranty-1',
      submitted_by_id: 'u-1001',
      description: 'Плинтус в коридоре отходит от стены.',
      evidence: ['ev-seed-3'],
      status: 'awaiting_confirmation',
      dispute_id: 'dsp-warranty-fix-1',
      submitted_at: iso(-6),
      fixes: [
        {
          id: 'wf-1',
          round: 1,
          submitted_by_id: 'u-2001',
          comment: 'Плинтус перекрепили на дюбели, стык закрыли.',
          evidence: [],
          submitted_at: iso(-1),
          contested_by_id: null,
          contest_comment: '',
          contest_evidence: [],
          contested_at: null,
        },
      ],
      fix_submitted_at: iso(-1),
      acceptance_deadline_at: iso(WARRANTY_CONFIRM_WINDOW_DAYS - 1),
    }),
  );

  seedEvidence('dsp-open-1', 'rc-progress-1', [
    { id: 'ev-seed-1', file_name: 'стяжка-у-порога.jpg', mime_type: 'image/jpeg', uploaded_by_id: 'u-2001', created_at: iso(-8) },
  ]);
  seedEvidence('dsp-warranty-1', 'rc-warranty-1', [
    { id: 'ev-seed-2', file_name: 'ламинат-стык.jpg', mime_type: 'image/jpeg', uploaded_by_id: 'u-1001', created_at: iso(-3) },
    { id: 'ev-seed-2b', file_name: 'замер-влажности.pdf', mime_type: 'application/pdf', uploaded_by_id: 'u-1001', created_at: iso(-3) },
  ]);
  seedEvidence('dsp-warranty-fix-1', 'rc-warranty-1', [
    { id: 'ev-seed-3', file_name: 'плинтус-коридор.jpg', mime_type: 'image/jpeg', uploaded_by_id: 'u-1001', created_at: iso(-6) },
  ]);

  // (7) окно оспаривания РАСТОРЖЕНИЯ (ADR-028) — без спора, только договор:
  // на дашборде это самостоятельная строка виджета.
  const terminationWindow = makeWindow({
    id: 'dw-term-1',
    kind: 'termination_notice',
    contract_id: 'rc-signed-cash-1',
    dispute_id: null,
    subject_ref: { type: 'contract', id: 'rc-signed-cash-1' },
    deadline_at: iso(3),
  });
  windows.set(terminationWindow.id, terminationWindow);
}

/**
 * Демо-набор витрины (`demoEn.ts`, EN и RU) идёт БЕЗ контура разногласий:
 * сиды споров держат на рабочем столе три «окна возражения» с бегущими
 * сроками — верный сценарий продукта, но для витрины это первый экран,
 * начинающийся с конфликта. Обычный человек их не видит, поэтому под флагом
 * реестры остаются пустыми. Дефолт (русские моки, все e2e) не меняется.
 */
function seedAll(): void {
  if (isDemoStore()) return;
  seed();
}

seedAll();

export function resetDisputes(): void {
  seedAll();
}

/** `counterparty` — ВТОРАЯ сторона относительно читателя (ADR-131 §9);
 * `show_name: false` отдаёт `display_name: null` — это согласие профиля. */
function counterpartyOf(record: DisputeRecord, actingProfileId: string): Dispute['counterparty'] {
  const otherProfileId = record.partyProfileIds.find((p) => p !== actingProfileId);
  if (!otherProfileId) return null;
  const settings = getProfileSettings(otherProfileId);
  const role = roleOf(record, otherProfileId);
  return {
    profile_id: otherProfileId,
    display_name: settings && settings.show_name ? settings.display_name : null,
    role,
    // ADR-173: фото контрагента — лид строки раздела «Споры».
    avatar_url: settings?.avatar_url ?? null,
  };
}

function roleOf(record: DisputeRecord, profileId: string): 'customer' | 'contractor' {
  try {
    const contract = getContract(record.contract_id);
    const party = contract.parties.find((p) => p.profile_id === profileId);
    if (party) return party.role;
  } catch {
    // договора в реестре нет — редкий случай сброса стора между тестами
  }
  return 'contractor';
}

function view(record: DisputeRecord, actingProfileId: string): Dispute {
  const { partyProfileIds: _parties, ...rest } = record;
  return {
    ...rest,
    counterparty: counterpartyOf(record, actingProfileId),
    fix_rounds_left: Math.max(MAX_FIX_ROUNDS - record.fix_rounds_used, 0),
    days_to_cap: daysToCap(record),
    windows: record.windows.map((w) => windows.get(w.id) ?? w),
  };
}

function mine(record: DisputeRecord, actingProfileId: string): boolean {
  return record.partyProfileIds.includes(actingProfileId);
}

function find(disputeId: string): DisputeRecord {
  const record = disputes.get(disputeId);
  if (!record) throw new DisputeMockError(404, 'not_found', 'Разногласие не найдено.');
  return record;
}

function assertNotResolved(record: DisputeRecord): void {
  if (record.status === 'resolved') {
    throw new DisputeMockError(409, 'dispute_already_resolved', 'Разногласие уже закрыто.');
  }
}

function assertStatus(record: DisputeRecord, allowed: DisputeStatus[]): void {
  assertNotResolved(record);
  if (!allowed.includes(record.status)) {
    throw new DisputeMockError(409, 'invalid_dispute_transition', 'Действие недоступно в текущем состоянии.');
  }
}

export function listDisputes(actingProfileId: string, filter: { kind?: string; status?: string }): Dispute[] {
  return [...disputes.values()]
    .filter((d) => mine(d, actingProfileId))
    .filter((d) => (filter.kind ? d.kind === filter.kind : true))
    .filter((d) => (filter.status ? d.status === filter.status : true))
    .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1))
    .map((d) => view(d, actingProfileId));
}

export function getDispute(disputeId: string, actingProfileId: string): Dispute {
  const record = find(disputeId);
  if (!mine(record, actingProfileId)) {
    throw new DisputeMockError(403, 'permission_denied', 'Вы не сторона этого договора.');
  }
  return view(record, actingProfileId);
}

/** `respond` — РЕПЛИКА, не переход FSM: статус не меняется, но окно ответа
 * закрывается как оспоренное (ADR-019/ADR-131 §1). */
export function respondToDispute(
  disputeId: string,
  actingProfileId: string,
  input: { comment: string; evidence: string[] },
): Dispute {
  const record = find(disputeId);
  assertNotResolved(record);
  if (userIdOf(actingProfileId) === record.opened_by_id) {
    throw new DisputeMockError(403, 'not_dispute_counterparty', 'Отвечает вторая сторона.');
  }
  record.evidence = [...record.evidence, ...input.evidence];
  record.replies = [
    ...record.replies,
    { id: nextId('rp'), author_id: userIdOf(actingProfileId), comment: input.comment, evidence: input.evidence, created_at: new Date().toISOString() },
  ];
  const open = record.windows.map((w) => windows.get(w.id)).find((w) => w && w.kind === 'dispute_response' && !w.closed_at);
  if (open) {
    open.contested = true;
    open.contested_by_id = userIdOf(actingProfileId);
    open.contested_at = new Date().toISOString();
    open.closed_at = new Date().toISOString();
  }
  return view(record, actingProfileId);
}

export function requestFix(disputeId: string, actingProfileId: string, input: { comment: string }): FixRequest {
  const record = find(disputeId);
  if (record.kind !== 'milestone') {
    throw new DisputeMockError(409, 'invalid_dispute_transition', 'У гарантийного разногласия раундов исправления нет.');
  }
  assertStatus(record, ['open']);
  if (roleOf(record, actingProfileId) !== 'customer') {
    throw new DisputeMockError(403, 'wrong_dispute_side', 'Раунд исправления просит заказчик.');
  }
  if (record.fix_rounds_used >= MAX_FIX_ROUNDS) {
    throw new DisputeMockError(409, 'fix_rounds_exhausted', 'Раунды исправления исчерпаны.');
  }
  const fixRequest: FixRequest = {
    id: nextId('fr'),
    round: record.fix_rounds_used + 1,
    requested_by_id: userIdOf(actingProfileId),
    comment: input.comment,
    requested_at: new Date().toISOString(),
    resubmitted_by_id: null,
    resubmit_comment: '',
    resubmitted_at: null,
  };
  record.fix_requests = [...record.fix_requests, fixRequest];
  record.fix_rounds_used += 1;
  record.status = 'awaiting_fix';
  return fixRequest;
}

export function resubmitFix(
  disputeId: string,
  fixRequestId: string,
  actingProfileId: string,
  input: { comment: string },
): FixRequest {
  const record = find(disputeId);
  assertStatus(record, ['awaiting_fix']);
  if (roleOf(record, actingProfileId) !== 'contractor') {
    throw new DisputeMockError(403, 'wrong_dispute_side', 'Исправление сдаёт исполнитель.');
  }
  const fixRequest = record.fix_requests.find((fr) => fr.id === fixRequestId);
  if (!fixRequest) throw new DisputeMockError(404, 'not_found', 'Раунд исправления не найден.');
  if (fixRequest.resubmitted_at) {
    throw new DisputeMockError(409, 'fix_request_already_resubmitted', 'Исправление по этому раунду уже сдано.');
  }
  fixRequest.resubmitted_by_id = userIdOf(actingProfileId);
  fixRequest.resubmit_comment = input.comment;
  fixRequest.resubmitted_at = new Date().toISOString();
  record.status = 'open';
  return fixRequest;
}

export function proposeDiscount(
  disputeId: string,
  actingProfileId: string,
  input: { new_amount: string; currency: string; anti_waiver_note: string; reason: string },
): DiscountAgreement {
  const record = find(disputeId);
  if (record.kind !== 'milestone' || !record.milestone_id) {
    throw new DisputeMockError(422, 'discount_not_applicable', 'У гарантийного разногласия листа нет.');
  }
  assertStatus(record, ['open', 'awaiting_fix']);
  const milestone = getMilestone(record.milestone_id);
  if (!milestone.amount || !milestone.amount_currency) {
    throw new DisputeMockError(422, 'discount_not_applicable', 'У этапа нет суммы — нечего уменьшать.');
  }
  if (input.currency !== milestone.amount_currency) {
    throw new DisputeMockError(422, 'discount_not_applicable', 'Валюта скидки не совпадает с валютой этапа.');
  }
  const next = Number(input.new_amount);
  if (!Number.isFinite(next) || next < 0 || next >= Number(milestone.amount)) {
    throw new DisputeMockError(422, 'discount_not_applicable', 'Скидка должна быть меньше суммы этапа и неотрицательной.');
  }
  if (!input.anti_waiver_note.trim()) {
    throw new DisputeMockError(422, 'discount_not_applicable', 'Оговорка об объёме обязательна: без неё скидку применить нельзя.');
  }
  // Допник создаётся ОБЩИМ контуром §8.6 (`create_discount_amendment`,
  // ADR-131 §3) — настоящая запись в `realContractsDb`, чтобы ссылка
  // «Подписать допсоглашение» вела на живой экран допника (принятие скидки =
  // подпись, не кнопка).
  const amendment = createDiscountAmendment(
    record.contract_id,
    { milestone_id: record.milestone_id, new_amount: Number(input.new_amount).toFixed(2), currency: input.currency, anti_waiver_note: input.anti_waiver_note, reason: input.reason },
    userIdOf(actingProfileId),
  );
  const agreement: DiscountAgreement = {
    id: nextId('da'),
    amendment_id: amendment.id,
    milestone_id: record.milestone_id,
    proposed_by_id: userIdOf(actingProfileId),
    old_amount: milestone.amount,
    old_amount_currency: milestone.amount_currency,
    new_amount: Number(input.new_amount).toFixed(2),
    new_amount_currency: input.currency,
    anti_waiver_note: input.anti_waiver_note,
    status: 'proposed',
    decided_by_id: null,
    decided_at: null,
    created_at: new Date().toISOString(),
  };
  record.discount_agreements = [...record.discount_agreements, agreement];
  record.status = 'awaiting_discount';
  return agreement;
}

export function declineDiscount(disputeId: string, agreementId: string, actingProfileId: string): DiscountAgreement {
  const record = find(disputeId);
  assertStatus(record, ['awaiting_discount']);
  const agreement = record.discount_agreements.find((d) => d.id === agreementId);
  if (!agreement) throw new DisputeMockError(404, 'not_found', 'Предложение скидки не найдено.');
  if (agreement.status !== 'proposed') {
    throw new DisputeMockError(409, 'discount_already_decided', 'Решение по скидке уже принято.');
  }
  if (agreement.proposed_by_id === userIdOf(actingProfileId)) {
    throw new DisputeMockError(403, 'not_dispute_counterparty', 'Решает вторая сторона.');
  }
  agreement.status = 'declined';
  agreement.decided_by_id = userIdOf(actingProfileId);
  agreement.decided_at = new Date().toISOString();
  record.status = 'open';
  return agreement;
}

/** Соответствие `resolution_type` → `outcome` (ADR-131 §6: детальный код и
 * классификация спеки — два разных поля). */
const RESOLUTION_OUTCOME: Record<DisputeApiResolutionType, Dispute['outcome']> = {
  accepted: 'resolved',
  withdrawn: 'resolved',
  escalated_to_court: 'escalated_to_court',
  warranty_satisfied: 'resolved',
  warranty_declined: 'resolved',
};

export function resolveDispute(
  disputeId: string,
  actingProfileId: string,
  input: { resolution_type: DisputeApiResolutionType },
): Dispute {
  const record = find(disputeId);
  assertNotResolved(record);
  const outcome = RESOLUTION_OUTCOME[input.resolution_type];
  if (!outcome) throw new DisputeMockError(422, 'validation_error', 'Неизвестный исход разногласия.');
  record.status = 'resolved';
  record.resolution_type = input.resolution_type;
  record.outcome = outcome;
  record.resolved_at = new Date().toISOString();
  // Незакрытые окна снимаются: оспаривать больше нечего (`contested` остаётся
  // null при заполненном `closed_at` — ровно случай «снято досрочно»).
  for (const ref of record.windows) {
    const w = windows.get(ref.id);
    if (w && !w.closed_at) w.closed_at = record.resolved_at;
  }
  for (const claim of claims.values()) {
    if (claim.dispute_id === record.id && claim.status !== 'resolved') {
      claim.status = 'resolved';
      claim.resolution_type = input.resolution_type;
      claim.resolved_at = record.resolved_at;
      claim.acceptance_deadline_at = null;
    }
  }
  return view(record, actingProfileId);
}

export function listWindows(actingProfileId: string, activeOnly: boolean): DisputeWindow[] {
  return [...windows.values()]
    .filter((w) => {
      const dispute = w.dispute_id ? disputes.get(w.dispute_id) : undefined;
      if (dispute) return mine(dispute, actingProfileId);
      try {
        return getContract(w.contract_id).parties.some((p) => p.profile_id === actingProfileId);
      } catch {
        return false;
      }
    })
    .filter((w) => (activeOnly ? w.closed_at === null : true))
    .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
}

export function contestWindow(windowId: string, actingProfileId: string, _input: { comment: string }): DisputeWindow {
  const window = windows.get(windowId);
  if (!window) throw new DisputeMockError(404, 'not_found', 'Окно не найдено.');
  if (window.closed_at) {
    throw new DisputeMockError(409, 'dispute_window_closed', 'Окно оспаривания уже закрыто.');
  }
  window.contested = true;
  window.contested_by_id = userIdOf(actingProfileId);
  window.contested_at = new Date().toISOString();
  window.closed_at = window.contested_at;
  return window;
}

export function listWarrantyClaims(actingProfileId: string): WarrantyClaim[] {
  return [...claims.values()]
    .filter((c) => {
      try {
        return getContract(c.contract_id).parties.some((p) => p.profile_id === actingProfileId);
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
}

export function listContractWarrantyClaims(contractId: string): WarrantyClaim[] {
  return [...claims.values()].filter((c) => c.contract_id === contractId);
}

/** `POST /contracts/{id}/warranty-claims` — открывает `Dispute(kind=warranty)`
 * (ADR-131 §7): диалоговый контур у претензии и разногласия ОДИН. */
export function submitWarrantyClaim(
  contractId: string,
  actingProfileId: string,
  input: { description: string; evidence: string[] },
): WarrantyClaim {
  const contract = getContract(contractId);
  const party = contract.parties.find((p) => p.profile_id === actingProfileId);
  if (!party) throw new DisputeMockError(403, 'permission_denied', 'Вы не сторона этого договора.');
  if (party.role !== 'customer') {
    throw new DisputeMockError(403, 'wrong_dispute_side', 'Гарантийную претензию подаёт заказчик.');
  }
  if (contract.execution_status !== 'warranty') {
    throw new DisputeMockError(422, 'warranty_period_not_active', 'Гарантийный период не идёт.');
  }
  if (input.evidence.length === 0) {
    throw new DisputeMockError(422, 'evidence_required', 'Нужно доказательство.');
  }
  const disputeId = nextId('dsp');
  const now = new Date().toISOString();
  disputes.set(
    disputeId,
    makeDispute({
      id: disputeId,
      kind: 'warranty',
      contract_id: contractId,
      milestone_id: null,
      checklist_item_id: null,
      opened_by_id: userIdOf(actingProfileId),
      partyProfileIds: contract.parties.map((p) => p.profile_id),
      evidence: input.evidence,
      opened_at: now,
      cap_deadline_at: iso(30),
      days_to_cap: 30,
    }),
  );
  const claim = makeClaim({
    id: nextId('wc'),
    contract_id: contractId,
    submitted_by_id: userIdOf(actingProfileId),
    description: input.description,
    evidence: input.evidence,
    dispute_id: disputeId,
    submitted_at: now,
  });
  claims.set(claim.id, claim);
  return claim;
}

// ═══════════════ Контур устранения по претензии (ADR-133) ═══════════════

function findClaim(claimId: string): ClaimRecord {
  const claim = claims.get(claimId);
  if (!claim) throw new DisputeMockError(404, 'not_found', 'Гарантийная претензия не найдена.');
  return claim;
}

function claimRoleOf(claim: ClaimRecord, actingProfileId: string): 'customer' | 'contractor' {
  const party = getContract(claim.contract_id).parties.find((p) => p.profile_id === actingProfileId);
  if (!party) throw new DisputeMockError(403, 'permission_denied', 'Вы не сторона этого договора.');
  return party.role;
}

function assertClaimOpen(claim: ClaimRecord): void {
  if (claim.status === 'resolved') {
    throw new DisputeMockError(409, 'warranty_claim_already_resolved', 'Гарантийная претензия уже закрыта.');
  }
}

function claimDispute(claim: ClaimRecord): DisputeRecord {
  const dispute = claim.dispute_id ? disputes.get(claim.dispute_id) : undefined;
  if (!dispute) throw new DisputeMockError(409, 'warranty_claim_dispute_missing', 'У претензии нет диалога.');
  return dispute;
}

/** `POST /warranty-claims/{id}/decline` — ИСПОЛНИТЕЛЬ отказывает: спор
 * закрывается `warranty_declined` в той же операции (`decline_warranty_claim`). */
export function declineWarrantyClaim(claimId: string, actingProfileId: string, _input: { comment: string }): WarrantyClaim {
  const claim = findClaim(claimId);
  assertClaimOpen(claim);
  if (claimRoleOf(claim, actingProfileId) !== 'contractor') {
    throw new DisputeMockError(403, 'wrong_dispute_side', 'Отказать по гарантийной претензии может исполнитель.');
  }
  const dispute = claimDispute(claim);
  resolveDispute(dispute.id, actingProfileId, { resolution_type: 'warranty_declined' });
  return claim;
}

/** `POST /warranty-claims/{id}/fix-submitted` — исполнитель «устранил»
 * (`submit_warranty_fix`): `submitted -> awaiting_confirmation`, строка
 * `WarrantyFix(round=fix_rounds_used+1)`, дедлайн окна подтверждения той же
 * длины, что окно приёмки; повторно, пока окно идёт, — 409
 * `warranty_claim_awaiting_confirmation`. Потолка на сдачи нет — он на
 * возражения заказчика. */
export function submitWarrantyFix(claimId: string, actingProfileId: string, input: { comment: string; evidence: string[] }): WarrantyFix {
  const claim = findClaim(claimId);
  assertClaimOpen(claim);
  if (claim.status === 'awaiting_confirmation') {
    throw new DisputeMockError(409, 'warranty_claim_awaiting_confirmation', 'Претензия уже ждёт подтверждения заказчика.');
  }
  if (claimRoleOf(claim, actingProfileId) !== 'contractor') {
    throw new DisputeMockError(403, 'wrong_dispute_side', 'Об устранении сообщает исполнитель.');
  }
  const dispute = claimDispute(claim);
  const now = new Date().toISOString();
  const fix: WarrantyFix = {
    id: nextId('wf'),
    round: claim.fix_rounds_used + 1,
    submitted_by_id: userIdOf(actingProfileId),
    comment: input.comment,
    evidence: input.evidence,
    submitted_at: now,
    contested_by_id: null,
    contest_comment: '',
    contest_evidence: [],
    contested_at: null,
  };
  claim.fixes = [...claim.fixes, fix];
  claim.status = 'awaiting_confirmation';
  claim.fix_submitted_at = now;
  // На бэке дедлайн стартует с размещения уведомления в ЛК (ADR-057); в
  // моке уведомление «размещено» сразу.
  claim.acceptance_deadline_at = iso(WARRANTY_CONFIRM_WINDOW_DAYS);
  dispute.evidence = [...dispute.evidence, ...input.evidence];
  return fix;
}

/** `POST /warranty-claims/{id}/satisfy` — ЗАКАЗЧИК подтверждает устранение
 * из ЛЮБОГО незакрытого статуса («сделали на месте» — тоже): претензия и
 * спор закрываются `warranty_satisfied`, окно подтверждения снимается. */
export function satisfyWarrantyClaim(claimId: string, actingProfileId: string, _input: { comment: string } = { comment: '' }): WarrantyClaim {
  const claim = findClaim(claimId);
  assertClaimOpen(claim);
  if (claimRoleOf(claim, actingProfileId) !== 'customer') {
    throw new DisputeMockError(403, 'wrong_dispute_side', 'Подтверждает устранение заказчик.');
  }
  const dispute = claimDispute(claim);
  resolveDispute(dispute.id, actingProfileId, { resolution_type: 'warranty_satisfied' });
  return claim;
}

/** `POST /warranty-claims/{id}/contest` — заказчик: «не устранено» (только
 * в `awaiting_confirmation`, комментарий обязателен). Возражение — раунд:
 * `fix_rounds_used += 1`, третье — 409 `fix_rounds_exhausted`; претензия
 * -> `submitted`, окно подтверждения снимается. */
export function contestWarrantyFix(claimId: string, actingProfileId: string, input: { comment: string; evidence: string[] }): WarrantyClaim {
  const claim = findClaim(claimId);
  assertClaimOpen(claim);
  if (claim.status !== 'awaiting_confirmation') {
    throw new DisputeMockError(409, 'warranty_claim_not_awaiting_confirmation', 'Претензия не ждёт подтверждения — возражать нечему.');
  }
  if (claimRoleOf(claim, actingProfileId) !== 'customer') {
    throw new DisputeMockError(403, 'wrong_dispute_side', 'Возражает по устранению заказчик.');
  }
  if (claim.fix_rounds_used >= MAX_FIX_ROUNDS) {
    throw new DisputeMockError(409, 'fix_rounds_exhausted', 'Возражения «не устранено» исчерпаны.');
  }
  if (!input.comment.trim()) {
    // DRF-валидация сериализатора (`comment` обязателен) — 400, не доменный 422.
    throw new DisputeMockError(400, 'validation_error', 'Нужно описать, что именно не устранено.');
  }
  const dispute = claimDispute(claim);
  const fix = [...claim.fixes].reverse().find((f) => f.contested_at === null);
  const now = new Date().toISOString();
  if (fix) {
    fix.contested_by_id = userIdOf(actingProfileId);
    fix.contest_comment = input.comment;
    fix.contest_evidence = input.evidence;
    fix.contested_at = now;
  }
  dispute.evidence = [...dispute.evidence, ...input.evidence];
  claim.fix_rounds_used += 1;
  claim.fix_rounds_left = Math.max(MAX_FIX_ROUNDS - claim.fix_rounds_used, 0);
  claim.status = 'submitted';
  claim.fix_submitted_at = null;
  claim.acceptance_deadline_at = null;
  return claim;
}

/** Свип окна подтверждения (`auto_satisfy_warranty_claim`: на бэке — раз в
 * минуту по `DomainDeadline`, не отложенной задачей): молчание заказчика =
 * `warranty_satisfied` с `auto=True` в событии (в сериализаторе заявки
 * признака «авто» нет). В моке вызывается тестами явно. */
export function sweepWarrantyConfirmations(now = new Date()): WarrantyClaim[] {
  const closed: WarrantyClaim[] = [];
  for (const claim of claims.values()) {
    if (claim.status !== 'awaiting_confirmation' || !claim.acceptance_deadline_at) continue;
    if (Date.parse(claim.acceptance_deadline_at) > now.getTime()) continue;
    const dispute = claimDispute(claim);
    if (dispute.status !== 'resolved') {
      dispute.status = 'resolved';
      dispute.resolution_type = 'warranty_satisfied';
      dispute.outcome = 'resolved';
      dispute.resolved_at = now.toISOString();
      for (const ref of dispute.windows) {
        const w = windows.get(ref.id);
        if (w && !w.closed_at) w.closed_at = dispute.resolved_at;
      }
    }
    claim.status = 'resolved';
    claim.resolution_type = 'warranty_satisfied';
    claim.resolved_at = now.toISOString();
    claim.acceptance_deadline_at = null;
    closed.push(claim);
  }
  return closed;
}

// ═══ Подписчик на события допника (`apps.disputes.handlers`, ADR-131 §3) ═══
// Скидка = допник: подписан обеими сторонами -> спор закрыт
// `discount_accepted`; отклонён/отозван -> предложение `declined`, спор
// снова `open` (ждать подписи больше нечего).
subscribeAmendmentEvents((event) => {
  for (const record of disputes.values()) {
    const agreement = record.discount_agreements.find((d) => d.amendment_id === event.amendmentId && d.status === 'proposed');
    if (!agreement) continue;
    const now = new Date().toISOString();
    if (event.topic === 'amendment.signed_final') {
      agreement.status = 'accepted';
      agreement.decided_by_id = event.actorUserId;
      agreement.decided_at = now;
      if (record.status !== 'resolved') {
        record.status = 'resolved';
        record.resolution_type = 'discount_accepted';
        record.outcome = 'resolved';
        record.resolved_at = now;
        for (const ref of record.windows) {
          const w = windows.get(ref.id);
          if (w && !w.closed_at) w.closed_at = now;
        }
      }
    } else {
      agreement.status = 'declined';
      agreement.decided_by_id = event.actorUserId;
      agreement.decided_at = now;
      if (record.status === 'awaiting_discount') record.status = 'open';
    }
  }
});

/** Плоский поиск по доказательствам разногласий — для `GET /evidence/{id}/
 * thumbnail|download`: реестр `realContractsDb` знает только доказательства
 * этапов, а файл, приложенный в споре, скачивается тем же эндпоинтом. */
export function findDisputeEvidence(evidenceId: string): RealEvidence | null {
  for (const list of disputeEvidence.values()) {
    const found = list.find((e) => e.id === evidenceId);
    if (found) return found;
  }
  return null;
}

export function listDisputeEvidence(disputeId: string): RealEvidence[] {
  find(disputeId);
  return disputeEvidence.get(disputeId) ?? [];
}

/** `POST /disputes/{id}/evidence` — контрдоказательство внутри разногласия;
 * договор берётся из `dispute.contract` (у гарантийного этапа нет). */
export function uploadDisputeEvidence(
  disputeId: string,
  actingProfileId: string,
  file: { name: string; type: string; size: number },
): RealEvidence {
  const record = find(disputeId);
  const now = new Date().toISOString();
  const item: RealEvidence = {
    id: nextId('ev'),
    contract_id: record.contract_id,
    milestone_id: null,
    checklist_item_id: null,
    dispute_id: disputeId,
    uploaded_by_id: userIdOf(actingProfileId),
    file_name: file.name,
    description: '',
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    file_hash: `${file.name}`.padEnd(64, '0').slice(0, 64),
    trusted_timestamp_at: now,
    trusted_timestamp_source: 'mock-tsa',
    has_thumbnail: false,
    metadata: {},
    storage_mode: 'ru',
    delivery_status: 'delivered',
    delivered_to_counterparty_at: now,
    backup_status: 'not_requested',
    backup_provider: '',
    backup_completed_at: null,
    backup_failure_reason: '',
    backup_drive_file_id: '',
    backup_drive_web_view_link: '',
    created_at: now,
  };
  disputeEvidence.set(disputeId, [...(disputeEvidence.get(disputeId) ?? []), item]);
  return item;
}
