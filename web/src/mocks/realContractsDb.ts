/**
 * Мок-стор РЕАЛЬНОГО контура сделки (apps.contracts/apps.milestones) — Фаза 1,
 * docs/adr/ADR-088-contracts-execution-flow-real-contract.md, docs/tasks/
 * Промт_contracts-phase1-read-create.md. ОТДЕЛЬНО от `contractsDb.ts` (тот
 * зеркалит СТАРЫЙ мок-агрегат `ContractDetail`, всё ещё используется
 * страницами вне этой фазы) — здесь зеркалится РЕАЛЬНЫЙ, раздельный REST-
 * контракт: `Contract`/`Milestone` — узкие сериализаторы, дерево этапов
 * строится на чтении (`build_tree`), не хранится готовым деревом.
 */
import { materialCatalog } from './catalog';
import { formSchemaFieldType, formSchemaHasField } from './formSchemas';
import { applyDemoEn, isDemoStore } from './demoEn';
import { DEMO_EN_COUNTERPARTIES, getProfileSettings } from './profilesDb';
import type {
  ContractRole,
  DashboardAttentionItem,
  NegotiationStatus,
  RealAmendment,
  RealAmendmentChange,
  RealAmendmentChangeType,
  RealAmendmentCloseInput,
  RealAmendmentCreateInput,
  RealEffectiveTerms,
  PaymentSectionItem,
  StageSectionItem,
  RealChecklistItem,
  RealChecklistItemCreateInput,
  RealChecklistItemPatchInput,
  RealContract,
  RealContractCreateInput,
  RealContractMaterial,
  RealContractMaterialCreateInput,
  RealContractMaterialPatchInput,
  RealContractPatchInput,
  RealContractVersion,
  RealDeclineSignatureRequestInput,
  RealEvidence,
  RealForwardSignatureRequestInput,
  RealGateConditionState,
  RealMilestone,
  RealMilestoneAcceptanceStatus,
  RealMilestoneCreateInput,
  RealMilestoneGateReason,
  RealMilestoneGateStatus,
  RealMilestonePatchInput,
  RealMilestoneStatus,
  RealMilestoneSubmitInput,
  RealMilestoneTreeNode,
  RealPayment,
  RealPaymentKind,
  RealPaymentMethod,
  RealPaymentSide,
  RealPaymentStatus,
  RealPreapprovedAlternative,
  RealRevisionProposal,
  RealSignature,
  RealSignatoryOption,
  RealSignatureRequest,
  RealSignatureRequestCreateInput,
  RealSignInput,
  RealTimelineEvent,
} from '@porukam/core';

/** Владельцы (`User.id`, НЕ `profile_id`) — `apps.contracts.services.
 * list_signatories`: подписант адресуется юзером, X-Acting-Profile тут ни
 * при чём (та же развилка «профиль ≠ пользователь», что и на реальном
 * бэке). `pf-person-1` — `u-1001` (тот же id, что `web/src/mocks/data.ts:
 * mockUser`, `GET /users/me`), иначе локально «я» и «подписант» разъедутся. */
const OWNER_USER_ID: Record<string, string> = {
  'pf-person-1': 'u-1001',
  'pf-mock-contractor-1': 'u-2001',
};

/** Имя стороны для разделов /stages и /payments (`SectionCounterparty.
 * display_name`, ADR-109); на бэке — `profiles.selectors.public_display_name`.
 *
 * Источник имени один — `profilesDb` (тот же реестр, что отдаёт
 * `GET /profiles/{id}`, которым карточка договора и список резолвят
 * контрагента). Раньше тут лежала своя копия-константа, и она разъехалась с
 * profilesDb; теперь `pf-mock-contractor-1` — одна личность («Марат
 * Отделкин») во всех мок-БД (хвосты 2026-08-25).
 *
 * Читаем ЛЕНИВО, на каждый вызов: реестр сбрасывается `resetProfilesDb()`
 * между тестами (`web/tests/setup.ts`), модульная константа отстала бы.
 * `getProfileSettings`, а не `ensureProfileSettings` — чтение не должно
 * заводить профиль побочным эффектом. `show_name === false → null` — та же
 * семантика, что у `public_display_name` на бэке. */
function displayNameOf(profileId: string): string | null {
  const profile = getProfileSettings(profileId);
  if (!profile || !profile.show_name) return null;
  return profile.display_name;
}

/** ADR-173: фото контрагента строки раздела. Видимость `deals_only` здесь
 * не гейтит — читатель разделов и есть контрагент сделки (бэк проверяет то
 * же самое `avatar_url_for_request`). В сиде картинок нет — `null`, пока
 * фото не загрузят через `/profiles/{id}/avatar`. */
function avatarUrlOf(profileId: string): string | null {
  return getProfileSettings(profileId)?.avatar_url ?? null;
}

export class RealMockError extends Error {
  status: number;
  code: string;
  /** `context` problem+json — полевые ошибки 422 (`errors`), сводка accept-all. */
  context?: Record<string, unknown>;
  constructor(status: number, code: string, detail: string, context?: Record<string, unknown>) {
    super(detail);
    this.status = status;
    this.code = code;
    this.context = context;
  }
}

interface MilestoneRecord {
  id: string;
  parent_id: string | null;
  order: number;
  title: string;
  status: RealMilestoneStatus;
  amount: string | null;
  currency: string | null;
  sphere_code: string | null;
  deadline: string | null;
  depends_on_id: string | null;
  frozen_days: number | null;
  started_at: string | null;
  submitted_at: string | null;
  accepted_at: string | null;
  paid_confirmed_by_customer_at: string | null;
  paid_confirmed_by_contractor_at: string | null;
  created_at: string;
}

interface ContractRecord {
  /** `frozen_version_id` тоже вычисляется при сериализации (из
   * `frozenVersion` ниже — единственный источник правды, как FK на бэке),
   * а не хранится в сиде. */
  contract: Omit<RealContract, 'total' | 'initiator_role' | 'frozen_version_id' | 'materials_seen_at'>;
  initiatorRole: ContractRole;
  /** ADR-158: отметка «материалы просмотрены» — ПО СТОРОНЕ (как
   * `ContractParty.materials_seen_at` на бэке), поэтому в сериализации она
   * зависит от смотрящего (X-Acting-Profile), а не хранится в `contract`. */
  materialsSeenAt?: Partial<Record<ContractRole, string>>;
  milestones: MilestoneRecord[];
  checklistItems: Map<string, RealChecklistItem[]>;
  /** `GET/POST /milestones/{id}/evidence` (ADR-088 Фаза 5, ГВ.3) — ключ
   * `milestone_id`. */
  evidence: Map<string, RealEvidence[]>;
  /** `GET /milestones/{id}/timeline` — лента конкретного этапа, ОТДЕЛЬНО от
   * `timeline` договора целиком ниже (та же развилка, что на реальном
   * бэке — `apps.milestones.selectors.get_timeline` vs `apps.contracts`). */
  milestoneTimeline: Map<string, RealTimelineEvent[]>;
  revisions: RealRevisionProposal[];
  preapproved: RealPreapprovedAlternative[];
  signatureRequests: RealSignatureRequest[];
  timeline: RealTimelineEvent[];
  /** `Contract.frozen_version` — Фаза 4 (ADR-088). `null` — ещё не заморожен
   * (или снят заморозкой при `decline_for_revision`, тот же приём, что
   * реальный бэк — append-only версии, но ССЫЛКА на текущую снимается). */
  frozenVersion: RealContractVersion | null;
  signatures: RealSignature[];
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  // `-n-` вместо `-n`: сидовые записи уже занимают `ms-1`…`ms-8`, и созданный
  // в рантайме `ms-5` находился плоским поиском в ЧУЖОМ (подписанном) сиде —
  // 409 на PATCH/DELETE собственного черновика (всплыло на e2e ADR-101).
  return `${prefix}-n-${seq}`;
}

const registry = new Map<string, ContractRecord>();

/**
 * Платежи РЕАЛЬНОГО контура (`apps.payments`, Э5 волна 1 — ADR-130).
 * ОТДЕЛЬНОЙ картой, а не полем `ContractRecord`: платёж — самостоятельная
 * сущность со своим id (ровно как таблица `payment` с FK на договор), и
 * заводить её полем пришлось бы дописать в каждый из полутора десятков
 * сидов. Ключ — `contract_id`, как `Payment.objects.filter(contract=...)`.
 *
 * Старый мок-контур платежей (`paymentsDb.ts`, эквайринг/СБП) — ДРУГАЯ
 * сущность и другой стор; коллизии URL разводятся неймспейсом id
 * (`rpay-*` здесь), см. `realContractsHandlers.ts`.
 */
const paymentRegistry = new Map<string, PaymentRecord[]>();

/**
 * Материалы этапов РЕАЛЬНОГО контура (`apps.milestones.ContractMaterial`,
 * ADR-047) — ОТДЕЛЬНОЙ картой по id ЭТАПА, как `paymentRegistry` по договору:
 * материал заводится своим ресурсом (`/milestones/{id}/materials`), и полем
 * `ContractRecord` его пришлось бы дописывать в каждый из двух десятков сидов.
 */
const materialRegistry = new Map<string, RealContractMaterial[]>();

/**
 * Допники РЕАЛЬНОГО контура (`apps.contracts.Amendment`, Э4.5, tech-spec.md
 * §8.6) — отдельной картой по id ДОПНИКА (свой URL-корень `/amendments/{id}`
 * на бэке); договор — через `contract_id`. Заявки на подпись и подписи допника
 * лежат В ЗАПИСИ ДОПНИКА (на бэке — те же таблицы с `amendment_id`, отдельная
 * реверс-связь `amendment.signature_requests`), поэтому `signSignatureRequest`
 * и соседи ищут заявку и в договорах, и здесь — «дуальная развилка» views.py.
 */
const amendmentRegistry = new Map<string, AmendmentRecord>();

interface AmendmentRecord {
  amendment: Omit<RealAmendment, 'amount_delta' | 'days_delta' | 'frozen_version_id'>;
  frozenVersion: RealContractVersion | null;
  signatureRequests: RealSignatureRequest[];
  signatures: RealSignature[];
  timeline: RealTimelineEvent[];
}

/** Способы расчёта, работающие БЕЗ платёжного партнёра (`Payment.
 * TWO_SIDED_METHODS`). `direct_platform`/`hold` требуют партнёра — счета по
 * ним не выставляются вовсе, список приезжает пустым (а выставление на
 * реальном бэке отвечает 409 `payment_provider_not_configured`). */
const TWO_SIDED_METHODS = ['cash', 'external'];

interface PaymentRecord {
  id: string;
  contract_id: string;
  milestone_id: string;
  kind: RealPaymentKind;
  method: RealPaymentMethod;
  status: RealPaymentStatus;
  amount: string;
  currency: string;
  payer_confirmed_at: string | null;
  payee_confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  /** Просрочка — НЕ статус (ADR-130 §3): платёж остаётся `pending`. */
  overdue_at: string | null;
  created_at: string;
}

function isLeaf(record: ContractRecord, milestoneId: string): boolean {
  return !record.milestones.some((m) => m.parent_id === milestoneId);
}

/** Сумма листьев поддерева (тот же принцип, что `apps.milestones.selectors.
 * computed_amount` — ветка вычисляется, лист несёт своё значение). */
function computedAmount(record: ContractRecord, milestoneId: string): number | null {
  const node = record.milestones.find((m) => m.id === milestoneId);
  if (!node) return null;
  if (isLeaf(record, milestoneId)) return node.amount !== null ? Number(node.amount) : null;
  const children = record.milestones.filter((m) => m.parent_id === milestoneId);
  const sums = children.map((c) => computedAmount(record, c.id)).filter((v): v is number => v !== null);
  return sums.length > 0 ? sums.reduce((a, b) => a + b, 0) : null;
}

/** `apps.milestones.services.total_leaf_amount` — сумма ВСЕХ листьев по всем
 * корням. `null` — дерева ещё нет (черновик без этапов, Фаза 0 ADR-088). */
function totalLeafAmount(record: ContractRecord): { amount: string; currency: string } | null {
  const roots = record.milestones.filter((m) => m.parent_id === null);
  if (roots.length === 0) return null;
  const amounts = roots.map((r) => computedAmount(record, r.id)).filter((v): v is number => v !== null);
  if (amounts.length === 0) return null;
  const currency = record.milestones.find((m) => m.currency)?.currency ?? 'RUB';
  const total = amounts.reduce((a, b) => a + b, 0);
  return { amount: total.toFixed(2), currency };
}

function buildTreeNode(record: ContractRecord, m: MilestoneRecord): RealMilestoneTreeNode {
  const children = record.milestones.filter((c) => c.parent_id === m.id).sort((a, b) => a.order - b.order);
  const leaf = children.length === 0;
  const amount = leaf ? m.amount : (computedAmount(record, m.id)?.toFixed(2) ?? null);
  return {
    id: m.id,
    parent_id: m.parent_id,
    order: m.order,
    title: m.title,
    status: m.status,
    is_leaf: leaf,
    amount,
    currency: leaf ? m.currency : (amount !== null ? (record.milestones.find((x) => x.currency)?.currency ?? 'RUB') : null),
    sphere_code: m.sphere_code,
    deadline: m.deadline,
    depends_on_id: m.depends_on_id,
    frozen_days: m.frozen_days,
    submitted_at: m.submitted_at,
    accepted_at: m.accepted_at,
    children: children.map((c) => buildTreeNode(record, c)),
  };
}

export function buildTree(id: string): RealMilestoneTreeNode[] {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  return record.milestones
    .filter((m) => m.parent_id === null)
    .sort((a, b) => a.order - b.order)
    .map((m) => buildTreeNode(record, m));
}

/** `actingProfileId` — смотрящий (X-Acting-Profile): от него зависит только
 * `materials_seen_at` (ADR-158, отметка СВОЕЙ стороны; чужую бэк не отдаёт).
 * Без него — `null`, как у реального сериализатора без `request` в контексте. */
function toApiContract(record: ContractRecord, actingProfileId?: string): RealContract {
  return {
    ...record.contract,
    total: totalLeafAmount(record),
    initiator_role: record.initiatorRole,
    frozen_version_id: record.frozenVersion?.id ?? null,
    materials_seen_at: ownMaterialsSeenAt(record, actingProfileId),
  };
}

function partyRoleOf(record: ContractRecord, actingProfileId?: string): ContractRole | null {
  if (!actingProfileId) return null;
  return record.contract.parties.find((p) => p.profile_id === actingProfileId)?.role ?? null;
}

function ownMaterialsSeenAt(record: ContractRecord, actingProfileId?: string): string | null {
  const role = partyRoleOf(record, actingProfileId);
  return role ? (record.materialsSeenAt?.[role] ?? null) : null;
}

/** Срок «от сегодня» для сидов, где важна ЖИВАЯ срочность: даты фикстур
 * заморожены (2026-08…), а счётчик на дашборде («Требует внимания») должен
 * оставаться осмысленным в любой день — иначе он всегда «0 мин». Тот же приём,
 * что `overdue_at` у мок-платежа ниже. */
function seedDeadlineIn(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function seedMilestone(partial: Partial<MilestoneRecord> & Pick<MilestoneRecord, 'id' | 'title'>): MilestoneRecord {
  return {
    parent_id: null,
    order: 0,
    status: 'pending',
    amount: null,
    currency: null,
    sphere_code: null,
    deadline: null,
    depends_on_id: null,
    frozen_days: null,
    started_at: null,
    submitted_at: null,
    accepted_at: null,
    paid_confirmed_by_customer_at: null,
    paid_confirmed_by_contractor_at: null,
    created_at: '2026-08-01T00:00:00Z',
    ...partial,
  };
}

/** Сид-версия для сценариев Фазы 4 (заморозка уже случилась до старта теста).
 * `integrity_hash` — детерминированная заглушка (`id`, дополненный нулями до
 * 64 символов — форма как у настоящего sha256-хеша, не значение), НЕ реальный
 * sha256: мок не пересчитывает снимок, важно только что `sign()` ниже сверяет
 * его байт-в-байт с тем же значением. */
function mockVersion(id: string, contractId: string, frozenAt: string): RealContractVersion {
  const hash = id.padEnd(64, '0');
  return {
    id,
    contract_id: contractId,
    snapshot: {},
    integrity_hash: hash,
    hash_algorithm: 'sha256',
    frozen_at: frozenAt,
    trusted_timestamp_source: 'mock-tsa',
    trusted_timestamp_at: frozenAt,
    official_language: 'ru',
    renders: { ru: { language: 'ru', hash, document: {} } },
  };
}

function seed(): void {
  registry.clear();
  paymentRegistry.clear();
  amendmentRegistry.clear();
  materialRegistry.clear();
  seq = 0;

  // (a) черновик — Годвин (заказчик) без единого этапа: total=null (Фаза 0 ADR-088).
  registry.set('rc-draft-1', {
    contract: {
      id: 'rc-draft-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'draft',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Ремонт крана на кухне',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-1', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-2', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-15T09:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [{ event_id: 'te-1', topic: 'contract.drafted', occurred_at: '2026-08-15T09:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-draft-1' }, payload: {} }],
  });

  // (b) на согласовании — с деревом этапов (total реально считается).
  registry.set('rc-review-1', {
    contract: {
      id: 'rc-review-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'under_review',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Сборка мебели — гостиная',
      additional_terms: [],
      form_data: {
        sphere_code: 'furniture',
        work_description: 'Собрать шкаф-купе и стеллаж по чертежам заказчика, вынести упаковку.',
        location_type: 'onsite',
        location_address: 'Алматы, ул. Абая, 10, кв. 5',
        term_type: 'dates',
        start_date: '2026-09-01',
        end_date: '2026-09-05',
        price_type: 'fixed',
        warranty_period_days: 14,
        acceptance_window_hours: 72,
        subcontract_policy: 'forbidden',
        access_required: true,
        portfolio_visible: true,
      },
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-3', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-4', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-14T12:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [
      seedMilestone({ id: 'ms-1', title: 'Шкаф-купе', amount: '18000.00', currency: 'RUB', order: 0 }),
      seedMilestone({ id: 'ms-2', title: 'Стеллаж', amount: '7000.00', currency: 'RUB', order: 1 }),
    ],
    checklistItems: new Map([
      ['ms-1', [{ id: 'ci-1', milestone_id: 'ms-1', description: 'Двери открываются без перекоса', measurable_criterion: 'Зазор ≤ 2мм по всей высоте', required_evidence: ['фото'], order: 0, created_at: '2026-08-14T12:05:00Z' }]],
    ]),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [
      { event_id: 'te-2', topic: 'contract.drafted', occurred_at: '2026-08-14T12:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-review-1' }, payload: {} },
      { event_id: 'te-3', topic: 'negotiation.sent', occurred_at: '2026-08-14T12:10:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-review-1' }, payload: {} },
    ],
  });

  // (c) подписан, в работе — Годвин ИСПОЛНИТЕЛЬ (микс ролей на списке, приёмка 1).
  registry.set('rc-progress-1', {
    contract: {
      id: 'rc-progress-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'signed',
      execution_status: 'in_progress',
      payment_method: 'direct_platform',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Ремонт ванной комнаты',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-5', role: 'customer', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-6', role: 'contractor', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-10T10:00:00Z',
    },
    initiatorRole: 'customer',
    // Несколько корневых этапов одного договора — ADR-088 Фаза 5, покрыть
    // ветки статусов реального `StagePage` (ms-3 — основной сценарий сдачи/
    // evidence, остальные — по одному на статус для read-only веток).
    milestones: [
      seedMilestone({ id: 'ms-3', title: 'Плитка', amount: '45000.00', currency: 'RUB', order: 0, status: 'in_progress', started_at: '2026-08-10T11:00:00Z' }),
      // Гейт материалов держит НЕ флаг, а сам материал заказчика (ADR-155):
      // `mat-seed-electric` ниже заведён без «получено».
      seedMilestone({ id: 'ms-3-suspended', title: 'Электрика', order: 1, status: 'suspended', started_at: '2026-08-11T09:00:00Z', frozen_days: 3 }),
      seedMilestone({ id: 'ms-3-under-acceptance', title: 'Сантехника', order: 2, status: 'under_acceptance', started_at: '2026-08-09T09:00:00Z', submitted_at: '2026-08-14T09:00:00Z' }),
      seedMilestone({ id: 'ms-3-accepted', title: 'Демонтаж', order: 3, status: 'accepted', started_at: '2026-08-05T09:00:00Z', submitted_at: '2026-08-06T09:00:00Z', accepted_at: '2026-08-07T09:00:00Z' }),
      seedMilestone({ id: 'ms-3-disputed', title: 'Стяжка пола', order: 4, status: 'disputed', started_at: '2026-08-05T09:00:00Z' }),
    ],
    checklistItems: new Map([
      ['ms-3', [{ id: 'ci-ms3-1', milestone_id: 'ms-3', description: 'Швы затёрты ровно', measurable_criterion: 'Без зазоров по всей плоскости', required_evidence: ['фото'], order: 0, created_at: '2026-08-10T11:05:00Z' }]],
    ]),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [
      { event_id: 'te-4', topic: 'contract.signed', occurred_at: '2026-08-10T10:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-progress-1' }, payload: {} },
      // ADR-134: события дочерних сущностей — `nested`, с `subject` сущности
      // (этап/спор/допник); на карточке они свёрнуты одной группой.
      { event_id: 'te-4-n1', topic: 'milestone.accepted', nested: true, occurred_at: '2026-08-07T09:00:00Z', actor: { role: 'customer' }, subject: { type: 'milestone', id: 'ms-3-accepted', title: 'Демонтаж' }, payload: {}, detail: 'Заказчик принял этап без замечаний' },
      { event_id: 'te-4-n2', topic: 'milestone.submitted', nested: true, occurred_at: '2026-08-14T09:00:00Z', actor: { role: 'contractor' }, subject: { type: 'milestone', id: 'ms-3-under-acceptance', title: 'Сантехника' }, payload: {}, detail: 'Срок приёмки — 5 дней с размещения в ЛК' },
      { event_id: 'te-4-n3', topic: 'dispute.opened', nested: true, occurred_at: '2026-08-15T12:00:00Z', actor: { role: 'contractor' }, subject: { type: 'dispute', id: 'dsp-open-1', title: 'Спор по этапу «Стяжка пола»' }, payload: {}, detail: null },
      { event_id: 'te-4-n4', topic: 'amendment.sent', nested: true, occurred_at: '2026-08-24T12:00:01Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-1', title: 'Допсоглашение №2' }, payload: {}, detail: null },
    ],
  });

  // (c.0) гарантийный период (этап 7, ADR-131): работы приняты, договор в
  // `warranty` — единственный сид, на котором видно кнопку «Гарантийная
  // претензия». Годвин здесь ЗАКАЗЧИК: претензию подаёт получатель результата.
  registry.set('rc-warranty-1', {
    contract: {
      id: 'rc-warranty-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'signed',
      execution_status: 'warranty',
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Укладка ламината в спальне',
      additional_terms: [],
      form_data: { warranty_period_days: 180 },
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-war-1', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-war-2', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-07-20T09:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [
      seedMilestone({ id: 'ms-war-1', title: 'Подложка и укладка', amount: '26000.00', currency: 'RUB', order: 0, status: 'paid', started_at: '2026-07-21T09:00:00Z', submitted_at: '2026-07-28T09:00:00Z', accepted_at: '2026-07-29T09:00:00Z' }),
    ],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [
      { event_id: 'te-war-1', topic: 'contract.signed', occurred_at: '2026-07-20T10:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-warranty-1' }, payload: {} },
      { event_id: 'te-war-2', topic: 'contract.warranty_started', occurred_at: '2026-07-30T10:00:00Z', actor: {}, subject: { type: 'contract', id: 'rc-warranty-1' }, payload: {} },
    ],
  });

  // (c.1) подписан, `cash`, в работе — вкладка «Оплаты» (отсмотр 2026-08-25):
  // лист принят и ждёт отметок оплаты, лист уже оплачен обеими сторонами,
  // лист ещё в работе. Годвин — ЗАКАЗЧИК (в rc-progress-1 он исполнитель):
  // на `accepted`-листе видна кнопка «Оплатить», способ оплаты `cash` —
  // стороны фиксируют факт сами, платформа денег не держит (финмодель v2).
  registry.set('rc-paying-1', {
    contract: {
      id: 'rc-paying-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'signed',
      execution_status: 'in_progress',
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Ремонт балкона',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-pay-1', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-pay-2', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-18T10:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [
      seedMilestone({ id: 'ms-pay-1', title: 'Остекление', amount: '20000.00', currency: 'RUB', order: 0, status: 'accepted', started_at: '2026-08-19T09:00:00Z', submitted_at: '2026-08-21T09:00:00Z', accepted_at: '2026-08-22T09:00:00Z' }),
      seedMilestone({
        id: 'ms-pay-2',
        title: 'Отделка',
        amount: '8000.00',
        currency: 'RUB',
        order: 1,
        status: 'paid',
        started_at: '2026-08-18T11:00:00Z',
        submitted_at: '2026-08-19T09:00:00Z',
        accepted_at: '2026-08-19T12:00:00Z',
        paid_confirmed_by_customer_at: '2026-08-19T13:00:00Z',
        paid_confirmed_by_contractor_at: '2026-08-19T14:00:00Z',
      }),
      seedMilestone({ id: 'ms-pay-3', title: 'Уборка', amount: '2000.00', currency: 'RUB', order: 2, status: 'in_progress', started_at: '2026-08-23T09:00:00Z' }),
      // Э5/ADR-130: лист с платежом, отмеченным ОДНОЙ стороной (плательщик
      // отметил, получатель ещё нет) — зеркало `paid_confirmed_by_customer_at`
      // держим согласованным со счётом, как это делает
      // `apps.payments.services._mirror_into_milestone`.
      seedMilestone({
        id: 'ms-pay-4',
        title: 'Демонтаж перегородки',
        amount: '5000.00',
        currency: 'RUB',
        order: 3,
        status: 'accepted',
        started_at: '2026-08-19T09:00:00Z',
        submitted_at: '2026-08-22T09:00:00Z',
        accepted_at: '2026-08-23T09:00:00Z',
        paid_confirmed_by_customer_at: '2026-08-23T10:00:00Z',
      }),
      // Лист с ОТМЕНЁННЫМ счётом: этап принят, но счёт отозвали (ошиблись
      // суммой) — этап так и остаётся `accepted`, зеркало пустое.
      seedMilestone({
        id: 'ms-pay-5',
        title: 'Вывоз мусора',
        amount: '3000.00',
        currency: 'RUB',
        order: 4,
        status: 'accepted',
        started_at: '2026-08-20T09:00:00Z',
        submitted_at: '2026-08-22T12:00:00Z',
        accepted_at: '2026-08-23T12:00:00Z',
      }),
    ],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [{ event_id: 'te-pay-1', topic: 'contract.signed', occurred_at: '2026-08-18T10:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-paying-1' }, payload: {} }],
  });

  // Счета rc-paying-1 (Э5, ADR-130) — все состояния FSM платежа разом, чтобы
  // вкладка «Оплаты» и экран этапа проверялись в моках без ручной доводки:
  // просроченный `pending`, `confirmed`, «отмечен одной стороной»,
  // `cancelled`. Лист ms-pay-3 (`in_progress`) счёта НЕ имеет — постоплата
  // выставляется только после приёмки, и это ровно то, что должно быть
  // видно: строки без выставленного счёта во вкладке нет.
  //
  // `overdue_at` — относительно «сейчас», а не фиксированной датой: бейдж
  // «просрочено N дн.» считается от текущего момента, и прибитая дата
  // означала бы разное N в разные дни.
  paymentRegistry.set('rc-paying-1', [
    {
      id: 'rpay-pay-1',
      contract_id: 'rc-paying-1',
      milestone_id: 'ms-pay-1',
      kind: 'postpayment',
      method: 'cash',
      status: 'pending',
      amount: '20000.00',
      currency: 'RUB',
      payer_confirmed_at: null,
      payee_confirmed_at: null,
      cancelled_at: null,
      cancel_reason: '',
      overdue_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: '2026-08-22T09:05:00Z',
    },
    {
      id: 'rpay-pay-2',
      contract_id: 'rc-paying-1',
      milestone_id: 'ms-pay-2',
      kind: 'postpayment',
      method: 'cash',
      status: 'confirmed',
      amount: '8000.00',
      currency: 'RUB',
      payer_confirmed_at: '2026-08-19T13:00:00Z',
      payee_confirmed_at: '2026-08-19T14:00:00Z',
      cancelled_at: null,
      cancel_reason: '',
      overdue_at: null,
      created_at: '2026-08-19T12:05:00Z',
    },
    {
      id: 'rpay-pay-4',
      contract_id: 'rc-paying-1',
      milestone_id: 'ms-pay-4',
      kind: 'postpayment',
      method: 'cash',
      status: 'payer_confirmed',
      amount: '5000.00',
      currency: 'RUB',
      payer_confirmed_at: '2026-08-23T10:00:00Z',
      payee_confirmed_at: null,
      cancelled_at: null,
      cancel_reason: '',
      overdue_at: null,
      created_at: '2026-08-23T09:05:00Z',
    },
    {
      id: 'rpay-pay-5',
      contract_id: 'rc-paying-1',
      milestone_id: 'ms-pay-5',
      kind: 'postpayment',
      method: 'cash',
      status: 'cancelled',
      amount: '3000.00',
      currency: 'RUB',
      payer_confirmed_at: null,
      payee_confirmed_at: null,
      cancelled_at: '2026-08-23T13:00:00Z',
      cancel_reason: 'Счёт выставлен на неверную сумму',
      overdue_at: null,
      created_at: '2026-08-23T12:05:00Z',
    },
  ]);

  // (c.1b) подписан, ПРЕДОПЛАТА (`payment_order=before_start`, ADR-151/155):
  // оплата листа обеими сторонами — условие его старта, поэтому счёт есть с
  // момента подписания, а не после приёмки. Способ расчёта обычный (`cash`):
  // он говорит, ПО КАКИМ РЕЛЬСАМ платят, а не когда — способа `prepayment`
  // больше нет (ADR-155 §9). Годвин — ЗАКАЗЧИК, то есть плательщик. Счёт
  // материализуется «read-repair»-ом на `GET /contracts/{id}/payments`,
  // отдельным сидом не заводится. У листа есть материал заказчика
  // (`mat-seed-prepay`) — второе условие гейта в состоянии «Ждём».
  registry.set('rc-prepay-1', {
    contract: {
      id: 'rc-prepay-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'signed',
      execution_status: 'in_progress',
      payment_method: 'cash',
      payment_order: 'before_start',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Дизайн-проект кухни',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-prepay-1', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-prepay-2', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-24T10:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-prepay-1', title: 'Планировка', amount: '15000.00', currency: 'RUB', order: 0, status: 'pending' })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [{ event_id: 'te-prepay-1', topic: 'contract.signed', occurred_at: '2026-08-24T10:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-prepay-1' }, payload: {} }],
  });

  // (c.2) подписан, `cash` — гейт полностью зелёный, готов к `POST .../start`
  // (ADR-088 Фаза 5: `payment_method=cash` → `_financial_condition` всегда true,
  // отдельно от rc-progress-1 — там `direct_platform` держит гейт заблокированным
  // намеренно, «честная заглушка», Э5 ещё не подключён).
  registry.set('rc-signed-cash-1', {
    contract: {
      id: 'rc-signed-cash-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'signed',
      execution_status: 'in_progress',
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Установка забора',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-17', role: 'customer', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-18', role: 'contractor', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-14T10:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-cash-1', title: 'Столбы и секции', amount: '22000.00', currency: 'RUB', order: 0, status: 'pending' })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [{ event_id: 'te-cash-1', topic: 'contract.signed', occurred_at: '2026-08-14T10:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-signed-cash-1' }, payload: {} }],
  });

  // (c.3) подписан, этап сдан и ждёт приёмки — Годвин ЗАКАЗЧИК (ADR-088 Фаза 6:
  // `accept`/`reject` — только заказчик, апробировать оба действия нужен именно
  // этот ракурс, в отличие от rc-progress-1/rc-signed-cash-1, где Годвин исполнитель).
  registry.set('rc-signed-review-1', {
    contract: {
      id: 'rc-signed-review-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'signed',
      execution_status: 'in_progress',
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Поклейка обоев в спальне',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-19', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-20', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-12T09:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [
      seedMilestone({
        id: 'ms-review-1',
        title: 'Стены',
        amount: '15000.00',
        currency: 'RUB',
        order: 0,
        status: 'under_acceptance',
        started_at: '2026-08-12T10:00:00Z',
        submitted_at: '2026-08-15T09:00:00Z',
      }),
    ],
    checklistItems: new Map([
      [
        'ms-review-1',
        [
          { id: 'ci-review-1', milestone_id: 'ms-review-1', description: 'Швы совпадают, нет пузырей', measurable_criterion: 'Визуально ровно по всей стене', required_evidence: ['фото'], order: 0, created_at: '2026-08-12T10:05:00Z' },
          { id: 'ci-review-2', milestone_id: 'ms-review-1', description: 'Углы проклеены', measurable_criterion: 'Нет отслоений на углах', required_evidence: [], order: 1, created_at: '2026-08-12T10:06:00Z' },
        ],
      ],
    ]),
    evidence: new Map([
      [
        'ms-review-1',
        [
          {
            id: 'ev-review-1',
            contract_id: 'rc-signed-review-1',
            milestone_id: 'ms-review-1',
            checklist_item_id: 'ci-review-1',
            dispute_id: null,
            uploaded_by_id: 'u-2001',
            file_name: 'стена-1.jpg',
            description: 'Стена после шпаклёвки, левый угол',
            mime_type: 'image/jpeg',
            file_size: 204800,
            file_hash: 'ev-review-1'.padEnd(64, '0'),
            trusted_timestamp_at: '2026-08-15T08:30:00Z',
            trusted_timestamp_source: 'mock-tsa',
            has_thumbnail: false,
            metadata: {},
            storage_mode: 'ru',
            delivery_status: 'delivered',
            delivered_to_counterparty_at: '2026-08-15T08:31:00Z',
            backup_status: 'not_requested',
            backup_provider: '',
            backup_completed_at: null,
            backup_failure_reason: '',
            backup_drive_file_id: '',
            backup_drive_web_view_link: '',
            created_at: '2026-08-15T08:30:00Z',
          },
        ],
      ],
    ]),
    milestoneTimeline: new Map([
      ['ms-review-1', [{ event_id: 'mte-review-1', topic: 'milestone.submitted', occurred_at: '2026-08-15T09:00:00Z', actor: { role: 'contractor' }, subject: { type: 'milestone', id: 'ms-review-1' }, payload: {} }]],
    ]),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [{ event_id: 'te-review-1', topic: 'contract.signed', occurred_at: '2026-08-12T09:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-signed-review-1' }, payload: {} }],
  });

  // (d) архив — отклонён контрагентом (архивная вкладка, приглушённая строка).
  registry.set('rc-rejected-1', {
    contract: {
      id: 'rc-rejected-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'rejected_by_counterparty',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Покраска забора',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-7', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-8', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-01T08:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-4', title: 'Забор', amount: '5000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [{ event_id: 'te-5', topic: 'negotiation.rejected', occurred_at: '2026-08-02T08:00:00Z', actor: { role: 'contractor' }, subject: { type: 'contract', id: 'rc-rejected-1' }, payload: {} }],
  });

  // (e) заморожен, заявка на подпись ещё не создана ни для одной стороны
  // (`pending_signature` без единого `signature-requests`, Фаза 4 ADR-088).
  registry.set('rc-frozen-1', {
    contract: {
      id: 'rc-frozen-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'pending_signature',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Установка окон',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-9', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-10', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-12T09:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-5', title: 'Окна', amount: '30000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: mockVersion('cv-1', 'rc-frozen-1', '2026-08-12T09:30:00Z'),
    signatures: [],
    timeline: [
      { event_id: 'te-6', topic: 'contract.drafted', occurred_at: '2026-08-12T09:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-frozen-1' }, payload: {} },
      { event_id: 'te-7', topic: 'negotiation.frozen', occurred_at: '2026-08-12T09:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-frozen-1' }, payload: { version_id: 'cv-1', integrity_hash: 'cv-1'.padEnd(64, '0'), segment: 'free_c2c' } },
    ],
  });

  // (f) заявка на подпись Годвина (заказчик) ждёт ЕГО подписи — контрагент ещё
  // не маршрутизировал свою (happy-path первого шага Фазы 4).
  registry.set('rc-awaiting-my-turn-1', {
    contract: {
      id: 'rc-awaiting-my-turn-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'awaiting_signatures',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Поклейка обоев',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-11', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-12', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-11T09:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-6', title: 'Обои', amount: '12000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [
      {
        id: 'sr-1',
        contract_id: 'rc-awaiting-my-turn-1',
        amendment_id: null,
        version_id: 'cv-2',
        side: 'customer',
        routed_by_id: OWNER_USER_ID['pf-person-1']!,
        signatory_id: OWNER_USER_ID['pf-person-1']!,
        status: 'pending',
        sent_at: '2026-08-11T10:00:00Z',
        // Срок ответа на приглашение подписать — живой (см. `seedDeadlineIn`).
        expires_at: seedDeadlineIn(49),
        comment: '',
        locale: '',
      },
    ],
    frozenVersion: mockVersion('cv-2', 'rc-awaiting-my-turn-1', '2026-08-11T09:30:00Z'),
    signatures: [],
    timeline: [
      { event_id: 'te-8', topic: 'contract.drafted', occurred_at: '2026-08-11T09:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-awaiting-my-turn-1' }, payload: {} },
      { event_id: 'te-9', topic: 'negotiation.frozen', occurred_at: '2026-08-11T09:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-awaiting-my-turn-1' }, payload: { version_id: 'cv-2', integrity_hash: 'cv-2'.padEnd(64, '0'), segment: 'free_c2c' } },
      { event_id: 'te-10', topic: 'negotiation.signature_requested', occurred_at: '2026-08-11T10:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-awaiting-my-turn-1' }, payload: { side: 'customer' } },
    ],
  });

  // (g) контрагент УЖЕ подписал — Годвин (заказчик) следующий; проверяет ветку
  // «моя очередь, другая сторона подписала» (SignatureRow: waiting/signed/you).
  registry.set('rc-awaiting-other-signed-1', {
    contract: {
      id: 'rc-awaiting-other-signed-1',
      contract_type_code: 'services_individual',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'awaiting_signatures',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Электрика в прихожей',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-13', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-14', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-09T09:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-7', title: 'Проводка', amount: '20000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [
      {
        id: 'sr-2',
        contract_id: 'rc-awaiting-other-signed-1',
        amendment_id: null,
        version_id: 'cv-3',
        side: 'contractor',
        routed_by_id: OWNER_USER_ID['pf-mock-contractor-1']!,
        signatory_id: OWNER_USER_ID['pf-mock-contractor-1']!,
        status: 'signed',
        sent_at: '2026-08-09T10:00:00Z',
        expires_at: null,
        comment: '',
        locale: 'ru',
      },
      {
        id: 'sr-3',
        contract_id: 'rc-awaiting-other-signed-1',
        amendment_id: null,
        version_id: 'cv-3',
        side: 'customer',
        routed_by_id: OWNER_USER_ID['pf-person-1']!,
        signatory_id: OWNER_USER_ID['pf-person-1']!,
        status: 'pending',
        sent_at: '2026-08-09T10:05:00Z',
        expires_at: seedDeadlineIn(5),
        comment: '',
        locale: '',
      },
    ],
    frozenVersion: mockVersion('cv-3', 'rc-awaiting-other-signed-1', '2026-08-09T09:30:00Z'),
    signatures: [
      {
        id: 'sig-1',
        contract_id: 'rc-awaiting-other-signed-1',
        amendment_id: null,
        version_hash: 'cv-3'.padEnd(64, '0'),
        side: 'contractor',
        signatory_id: OWNER_USER_ID['pf-mock-contractor-1']!,
        signed_at: '2026-08-09T11:00:00Z',
        signature_basis: 'person',
      },
    ],
    timeline: [
      { event_id: 'te-11', topic: 'contract.drafted', occurred_at: '2026-08-09T09:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-awaiting-other-signed-1' }, payload: {} },
      { event_id: 'te-12', topic: 'negotiation.frozen', occurred_at: '2026-08-09T09:30:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-awaiting-other-signed-1' }, payload: { version_id: 'cv-3', integrity_hash: 'cv-3'.padEnd(64, '0'), segment: 'free_c2c' } },
      { event_id: 'te-13', topic: 'negotiation.signed', occurred_at: '2026-08-09T11:00:00Z', actor: { role: 'contractor' }, subject: { type: 'contract', id: 'rc-awaiting-other-signed-1' }, payload: { side: 'contractor' } },
    ],
  });

  // (h) Годвин выступает business-стороной (ИП «Тёплый ремонт») — реальный
  // список подписантов ВСЕГДА пуст для business (apps.authority/SigningAuthority
  // не смёржен, `services.list_signatories` докстринг) — честный блок в UI,
  // не выдуманный подписант.
  registry.set('rc-business-blocked-1', {
    contract: {
      id: 'rc-business-blocked-1',
      contract_type_code: 'services_business',
      deal_type: 'b2c',
      segment: 'business_c2c',
      negotiation_status: 'pending_signature',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Ремонт офиса',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-15', role: 'contractor', profile_id: 'pf-biz-1', entity_id: null, acting_as: 'business' },
        { id: 'cp-16', role: 'customer', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-13T09:00:00Z',
    },
    initiatorRole: 'contractor',
    milestones: [seedMilestone({ id: 'ms-8', title: 'Ремонт', amount: '150000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: mockVersion('cv-4', 'rc-business-blocked-1', '2026-08-13T09:30:00Z'),
    signatures: [],
    timeline: [
      { event_id: 'te-14', topic: 'contract.drafted', occurred_at: '2026-08-13T09:00:00Z', actor: { role: 'contractor' }, subject: { type: 'contract', id: 'rc-business-blocked-1' }, payload: {} },
      { event_id: 'te-15', topic: 'negotiation.frozen', occurred_at: '2026-08-13T09:30:00Z', actor: { role: 'contractor' }, subject: { type: 'contract', id: 'rc-business-blocked-1' }, payload: { version_id: 'cv-4', integrity_hash: 'cv-4'.padEnd(64, '0'), segment: 'business_c2c' } },
    ],
  });

  // (h) сделка второй организации (pf-biz-2 «СтройБыт»): у КАЖДОГО актёра из
  // переключателя есть свой список — смена актёра перезапрашивает выдачу по
  // X-Acting-Profile (queryKey с актёром, отсмотр 2026-08-19), и e2e
  // smoke/actor-switch проверяют это по непустому списку.
  registry.set('rc-biz2-1', {
    contract: {
      id: 'rc-biz2-1',
      contract_type_code: 'services_business',
      deal_type: 'b2c',
      segment: 'business_c2c',
      negotiation_status: 'under_review',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Отделка торгового зала',
      additional_terms: [],
      form_data: {},
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-30', role: 'contractor', profile_id: 'pf-biz-2', entity_id: null, acting_as: 'business' },
        { id: 'cp-31', role: 'customer', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-16T10:00:00Z',
    },
    initiatorRole: 'contractor',
    milestones: [seedMilestone({ id: 'ms-30', title: 'Отделка', amount: '90000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [
      { event_id: 'te-30', topic: 'contract.drafted', occurred_at: '2026-08-16T10:00:00Z', actor: { role: 'contractor' }, subject: { type: 'contract', id: 'rc-biz2-1' }, payload: {} },
    ],
  });

  // (l–n) под согласованием, НЕ услуги — продажа / аренда жилья / заём.
  // Нужны, чтобы модалку правок (ADR-123) можно было проверить на моках для
  // всех типов, у которых есть схема формы, а не только для `services_*`
  // (хвосты 2026-08-25). `under_review` — правки открываются только там.
  // Статусы этапов — дефолтный `pending`, signatureRequests пусты: иначе
  // договоры попали бы в «Требует внимания» и сломали счёт на дашборде.
  registry.set('rc-sale-review-1', {
    contract: {
      id: 'rc-sale-review-1',
      contract_type_code: 'sale_personal',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'under_review',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Продажа велосипеда',
      additional_terms: [],
      // Ключи — из `sale_personal` (formSchemas.ts): `identifiers` не заполнен,
      // он обязателен только для `category_code: electronics`.
      form_data: {
        category_code: 'hobby_sport',
        item_name: 'Велосипед Merida Big Nine 300',
        item_description: 'Горный велосипед, рама 19", пробег около 900 км.',
        condition: 'used',
        condition_defects_description: 'Царапина на верхней трубе рамы, потёртости на грипсах.',
        completeness: 'Велосипед, комплект ключей, насос.',
        photos: [],
        own_household_plot: false,
        price: '45000.00',
        delivery_type: 'handoff',
        delivery_deadline_type: 'date',
        delivery_date: '2026-09-10',
        inspection_window_hours: 24,
      },
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-32', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-33', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-18T09:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-sale-1', title: 'Передача велосипеда', amount: '45000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [
      { event_id: 'te-31', topic: 'contract.drafted', occurred_at: '2026-08-18T09:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-sale-review-1' }, payload: {} },
      { event_id: 'te-32', topic: 'negotiation.sent', occurred_at: '2026-08-18T09:10:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-sale-review-1' }, payload: {} },
    ],
  });

  registry.set('rc-rent-review-1', {
    contract: {
      id: 'rc-rent-review-1',
      contract_type_code: 'rent_home',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'under_review',
      execution_status: null,
      payment_method: 'cash',
      payment_order: 'after_acceptance',
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Аренда квартиры на Абая',
      additional_terms: [],
      // Ключи — из `rent_home` (schema_version 2).
      form_data: {
        address: 'Алматы, ул. Абая, 10, кв. 5',
        object_type: 'apartment',
        floor: 3,
        area_sqm: '52.00',
        cadastral_number: '01:234:5678:90',
        disposal_basis_type: 'owner',
        disposal_basis_document: 'Свидетельство о праве собственности от 12.03.2021',
        term_kind: 'long_term',
        term_months: 11,
        rent_amount: '180000.00',
        rent_payment_day: 5,
        utilities_mode: 'by_meter',
        deposit_amount: '180000.00',
        deposit_terms: 'Возвращается в течение 5 дней после сдачи квартиры по акту.',
        deposit_non_refundable: false,
        occupants: ['Годвин'],
        pets_allowed: false,
        smoking_allowed: false,
      },
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-34', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-35', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-18T11:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-rent-1', title: 'Первый месяц аренды', amount: '180000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [
      { event_id: 'te-33', topic: 'contract.drafted', occurred_at: '2026-08-18T11:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-rent-review-1' }, payload: {} },
      { event_id: 'te-34', topic: 'negotiation.sent', occurred_at: '2026-08-18T11:10:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-rent-review-1' }, payload: {} },
    ],
  });

  registry.set('rc-loan-review-1', {
    contract: {
      id: 'rc-loan-review-1',
      contract_type_code: 'loan_individuals',
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'under_review',
      execution_status: null,
      payment_method: 'external',
      payment_order: null,
      protected: false,
      uses_platform_template: true,
      jurisdiction: 'RU',
      title: 'Заём на ремонт',
      additional_terms: [],
      // Ключи — из `loan_individuals`. Сумма > 100 000, поэтому `interest_type`
      // здесь `rate` (условный дефолт схемы дал бы то же самое).
      form_data: {
        amount: '150000.00',
        interest_type: 'rate',
        interest_rate_percent: '12.00',
        repayment_type: 'lump_sum',
        due_date: '2027-02-01',
        total_interest_amount: '18000.00',
        transfer_method: 'off_platform',
        transfer_confirmation_note: 'Перевод по номеру телефона, чек прикладываем в доказательства.',
        early_repayment_allowed: true,
        purpose: 'Ремонт кухни.',
      },
      warnings: [],
      language: 'ru',
      parties: [
        { id: 'cp-36', role: 'customer', profile_id: 'pf-person-1', entity_id: null, acting_as: 'person' },
        { id: 'cp-37', role: 'contractor', profile_id: 'pf-mock-contractor-1', entity_id: null, acting_as: 'person' },
      ],
      created_at: '2026-08-18T13:00:00Z',
    },
    initiatorRole: 'customer',
    milestones: [seedMilestone({ id: 'ms-loan-1', title: 'Возврат займа', amount: '168000.00', currency: 'RUB', order: 0 })],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [
      { event_id: 'te-35', topic: 'contract.drafted', occurred_at: '2026-08-18T13:00:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-loan-review-1' }, payload: {} },
      { event_id: 'te-36', topic: 'negotiation.sent', occurred_at: '2026-08-18T13:10:00Z', actor: { role: 'customer' }, subject: { type: 'contract', id: 'rc-loan-review-1' }, payload: {} },
    ],
  });

  // Материал подписанного договора: правка после заморозки закрыта, но список
  // на карточке этапа виден — «после заморозки только просмотр» (03.09).
  materialRegistry.set('ms-3', [
    {
      id: 'mat-seed-1',
      milestone_id: 'ms-3',
      catalog_item_id: 'cat-tile',
      catalog_item_code: 'cat-tile',
      description: 'Плитка керамическая',
      external_url: null,
      quantity: '12',
      unit: 'm2',
      unit_price: '1200.00',
      unit_price_currency: 'RUB',
      source: 'customer',
      delivery_days: 3,
      delivery_base: 'contract_signing',
      handed_over_at: '2026-08-10T09:00:00Z',
      handed_over_by_id: 'pf-mock-contractor-1',
      received: true,
      received_at: '2026-08-10T12:00:00Z',
      received_by_id: 'pf-person-1',
      created_at: '2026-08-10T11:10:00Z',
    },
  ]);

  // ADR-155: материал заказчика, который ещё НЕ получен, — ровно он держит
  // гейт приостановленного этапа (раньше это был сид-флаг `materialsReady`,
  // ничем не подкреплённый). Заказчик здесь — pf-mock-contractor-1,
  // исполнитель — pf-person-1 (стороны rc-progress-1).
  materialRegistry.set('ms-3-suspended', [
    {
      id: 'mat-seed-electric',
      milestone_id: 'ms-3-suspended',
      catalog_item_id: 'cat-cable',
      catalog_item_code: 'cat-cable',
      description: 'Кабель ВВГнг 3×2.5',
      external_url: null,
      quantity: '80',
      unit: 'm',
      unit_price: '95.00',
      unit_price_currency: 'RUB',
      source: 'customer',
      delivery_days: 2,
      delivery_base: 'contract_signing',
      handed_over_at: null,
      handed_over_by_id: null,
      received: false,
      received_at: null,
      received_by_id: null,
      created_at: '2026-08-11T08:00:00Z',
    },
  ]);

  // Предоплатный договор (ADR-151/155): материал заказчика ждёт передачи —
  // на экране этапа видны обе кнопки («Материалы переданы» у заказчика,
  // «Материалы получены» у исполнителя) рядом с гейтом «Ждём».
  materialRegistry.set('ms-prepay-1', [
    {
      id: 'mat-seed-prepay',
      milestone_id: 'ms-prepay-1',
      catalog_item_id: 'cat-plan',
      catalog_item_code: 'cat-plan',
      description: 'Обмерный план квартиры',
      external_url: null,
      quantity: '1',
      unit: 'pcs',
      unit_price: '0.00',
      unit_price_currency: 'RUB',
      source: 'customer',
      delivery_days: 1,
      delivery_base: 'contract_signing',
      handed_over_at: null,
      handed_over_by_id: null,
      received: false,
      received_at: null,
      received_by_id: null,
      created_at: '2026-08-24T10:05:00Z',
    },
  ]);
}
/** Сид + английский демо-набор витрины (`demoEn.ts`, флаг `porukam.mockData`).
 * Подмена строк идёт ПОСЛЕ всех сидов и ровно один раз на сборку реестров —
 * иначе делитель сумм применился бы дважды. Без флага — no-op. */
function seedAll(): void {
  seed();
  seedAmendments();
  applyDemoEn(registry);
  applyDemoEn(paymentRegistry);
  applyDemoEn(materialRegistry);
  applyDemoEn(amendmentRegistry);
  spreadDemoCounterparties();
}

/** Договоры, которым демо-набор НЕ меняет контрагента: на них завязаны
 * подписанты (`OWNER_USER_ID` знает только двух человек), допники и чат. */
const DEMO_KEEP_COUNTERPARTY = new Set(['rc-draft-1', 'rc-review-1', 'rc-progress-1']);

/**
 * Раздаёт сид-договорам разных контрагентов из `DEMO_EN_COUNTERPARTIES`
 * (см. докстринг там): русский мок держит второй стороной одного человека, и
 * на витрине список сделок выглядел как восемь строк с одним именем. Меняется
 * ТОЛЬКО `profile_id` второй стороны и только под флагом демо-набора.
 */
function spreadDemoCounterparties(): void {
  if (!isDemoStore()) return;
  let i = 0;
  for (const record of registry.values()) {
    if (DEMO_KEEP_COUNTERPARTY.has(record.contract.id)) continue;
    const other = record.contract.parties.find((p) => p.profile_id !== 'pf-person-1');
    if (!other) continue;
    const next = DEMO_EN_COUNTERPARTIES[i % DEMO_EN_COUNTERPARTIES.length];
    if (next) other.profile_id = next[0];
    i += 1;
  }
}

seedAll();

export function resetRealContractsDb(): void {
  seedAll();
}

/** `apps.contracts.selectors.list_my_contracts`: «мои договоры» — сторона
 * через СВОЙ профиль (`user_owned_profile_ids`), и `role=` фильтрует по
 * СВОЕЙ роли в сделке, не по «есть ли вообще сторона с такой ролью»
 * (в 2-сторонней сделке последнее совпало бы всегда). `actingProfileId` —
 * из X-Acting-Profile (realContractsHandlers.ts), мок-эквивалент owned-профиля. */
export function listContracts(filter: { role?: string; negotiation_status?: string; segment?: string; actingProfileId?: string }): RealContract[] {
  return Array.from(registry.values())
    .filter((r) => !filter.actingProfileId || r.contract.parties.some((p) => p.profile_id === filter.actingProfileId))
    .filter((r) => !filter.negotiation_status || r.contract.negotiation_status === filter.negotiation_status)
    .filter((r) => !filter.segment || r.contract.segment === filter.segment)
    .filter(
      (r) =>
        !filter.role ||
        r.contract.parties.some((p) => p.role === filter.role && (!filter.actingProfileId || p.profile_id === filter.actingProfileId)),
    )
    .map((r) => toApiContract(r, filter.actingProfileId));
}

/** `apps.dashboards.selectors.get_dashboard` (ADR-090) — тот же приём на TS:
 * cross-cutting по ВСЕМ договорам реестра, не по одному. `actingProfileId` —
 * мок-эквивалент owned-профиля (тот же приём, что `listContracts`), сторона
 * `acceptance`/`submission` константна смыслом действия (принимает только
 * customer, сдаёт только contractor) — не читается отдельно. */
export function listAttention(actingProfileId: string | undefined): DashboardAttentionItem[] {
  const meUserId = actingProfileId ? OWNER_USER_ID[actingProfileId] : undefined;
  const items: DashboardAttentionItem[] = [];

  for (const record of registry.values()) {
    if (meUserId) {
      for (const sr of record.signatureRequests) {
        if (sr.status === 'pending' && sr.signatory_id === meUserId) {
          items.push({
            id: `signature:${sr.id}`,
            kind: 'signature',
            side: sr.side,
            contract_id: record.contract.id,
            title: record.contract.title,
            deadline_at: sr.expires_at,
          });
        }
      }
    }

    if (!actingProfileId) continue;
    const isCustomer = record.contract.parties.some((p) => p.role === 'customer' && p.profile_id === actingProfileId);
    const isContractor = record.contract.parties.some((p) => p.role === 'contractor' && p.profile_id === actingProfileId);

    for (const m of record.milestones) {
      if (!isLeaf(record, m.id)) continue;
      if (isCustomer && m.status === 'under_acceptance') {
        items.push({
          id: `acceptance:${m.id}`,
          kind: 'acceptance',
          side: 'customer',
          contract_id: record.contract.id,
          title: m.title,
          deadline_at: null, // мок не считает окно приёмки отдельно — «не показываем то, чего нет»
        });
      }
      if (isContractor && m.status === 'in_progress') {
        items.push({
          id: `submission:${m.id}`,
          kind: 'submission',
          side: 'contractor',
          contract_id: record.contract.id,
          title: m.title,
          deadline_at: m.deadline,
        });
      }
    }
  }

  return items.sort((a, b) => {
    if (a.deadline_at === b.deadline_at) return 0;
    if (a.deadline_at === null) return 1;
    if (b.deadline_at === null) return -1;
    return a.deadline_at < b.deadline_at ? -1 : 1;
  });
}

/** (лист, моя сторона, контрагент) по подписанным договорам актёра — общий
 * обход для разделов /stages и /payments (`apps.dashboards.selectors.
 * _leaf_context`, ADR-109). */
function leafContext(
  actingProfileId: string,
): { record: ContractRecord; m: MilestoneRecord; side: ContractRole; counterpartyProfileId: string }[] {
  const rows: { record: ContractRecord; m: MilestoneRecord; side: ContractRole; counterpartyProfileId: string }[] = [];
  for (const record of registry.values()) {
    if (record.contract.negotiation_status !== 'signed') continue;
    const mine = record.contract.parties.find((p) => p.profile_id === actingProfileId);
    if (!mine) continue;
    const other = record.contract.parties.find((p) => p.role !== mine.role);
    if (!other) continue;
    for (const m of record.milestones) {
      if (!isLeaf(record, m.id)) continue;
      rows.push({ record, m, side: mine.role, counterpartyProfileId: other.profile_id });
    }
  }
  return rows;
}

/** `GET /v1/dashboard/stages` (ADR-109) — `apps.dashboards.selectors.get_stages`. */
export function listStagesSection(actingProfileId: string): StageSectionItem[] {
  const items = leafContext(actingProfileId).map(({ record, m, side, counterpartyProfileId }) => ({
    id: m.id,
    contract_id: record.contract.id,
    contract_title: record.contract.title,
    title: m.title,
    status: m.status,
    amount: m.amount,
    amount_currency: m.currency,
    deadline: m.deadline,
    side,
    counterparty: {
      profile_id: counterpartyProfileId,
      display_name: displayNameOf(counterpartyProfileId),
      avatar_url: avatarUrlOf(counterpartyProfileId),
    },
  }));
  return items.sort((a, b) => {
    if (a.deadline === b.deadline) return 0;
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  });
}

/** `GET /v1/dashboard/payments` (ADR-109) — `apps.dashboards.selectors.
 * get_payments`: только денежные листья, `state` из двусторонних
 * подтверждений §6.3. */
export function listPaymentsSection(actingProfileId: string): PaymentSectionItem[] {
  const order = { awaiting_confirmation: 0, upcoming: 1, paid: 2 } as const;
  const items: PaymentSectionItem[] = [];
  for (const { record, m, side, counterpartyProfileId } of leafContext(actingProfileId)) {
    if (m.amount === null || m.currency === null) continue;
    const bothConfirmed =
      m.paid_confirmed_by_customer_at !== null && m.paid_confirmed_by_contractor_at !== null;
    const state = m.status === 'paid' || bothConfirmed ? 'paid' : m.status === 'accepted' ? 'awaiting_confirmation' : 'upcoming';
    const myMark = side === 'customer' ? m.paid_confirmed_by_customer_at : m.paid_confirmed_by_contractor_at;
    const otherMark = side === 'customer' ? m.paid_confirmed_by_contractor_at : m.paid_confirmed_by_customer_at;
    items.push({
      milestone_id: m.id,
      contract_id: record.contract.id,
      contract_title: record.contract.title,
      milestone_title: m.title,
      amount: m.amount,
      amount_currency: m.currency,
      payment_method: record.contract.payment_method,
      state,
      paid_confirmed_by_me: myMark !== null,
      paid_confirmed_by_counterparty: otherMark !== null,
      accepted_at: m.accepted_at,
      deadline: m.deadline,
      side,
      counterparty: {
        profile_id: counterpartyProfileId,
        display_name: displayNameOf(counterpartyProfileId),
        avatar_url: avatarUrlOf(counterpartyProfileId),
      },
    });
  }
  return items.sort((a, b) => {
    if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
    if (a.deadline === b.deadline) return 0;
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  });
}

/**
 * Знает ли РЕАЛЬНЫЙ мок такой договор. Нужен хендлерам, которые делят путь со
 * старым мок-слоем (`contractHandlers`): MSW отдаёт запрос ПЕРВОМУ совпавшему
 * хендлеру, а реальный слой зарегистрирован раньше — и на legacy-идентификатор
 * (c-3001, c-6001) отвечал 404 вместо того, чтобы пропустить запрос дальше.
 */
export function isRealContract(id: string): boolean {
  return registry.has(id);
}

export function getContract(id: string, actingProfileId?: string): RealContract {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  return toApiContract(record, actingProfileId);
}

/** `POST /contracts/{id}/materials-seen` (ADR-158) — та же семантика, что у
 * `apps.contracts.services.mark_materials_seen`: только сторона (403 чужому),
 * отметка МОНОТОННА (назад не двигается) и зажата «сейчас», вторая сторона не
 * затрагивается. Поэтому повтор безвреден и ключ идемпотентности не нужен. */
export function markMaterialsSeen(id: string, actingProfileId?: string, seenAt?: string | null): { materials_seen_at: string | null } {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  const role = partyRoleOf(record, actingProfileId);
  if (!role) throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора.');
  const now = Date.now();
  const asked = seenAt ? Date.parse(seenAt) : now;
  if (Number.isNaN(asked)) throw new RealMockError(400, 'validation_error', 'Некорректный момент просмотра.');
  const moment = new Date(Math.min(asked, now)).toISOString();
  const current = record.materialsSeenAt?.[role] ?? null;
  const next = current && Date.parse(current) >= Date.parse(moment) ? current : moment;
  record.materialsSeenAt = { ...record.materialsSeenAt, [role]: next };
  return { materials_seen_at: next };
}

export function createContract(input: RealContractCreateInput): RealContract {
  const id = nextId('rc');
  const record: ContractRecord = {
    contract: {
      id,
      // ADR-094: «Услуга» без явного кода — зеркало серверного резолва
      // (resolve_service_contract_type_code; упрощённо по acting_as, статус СМЗ мок не знает).
      contract_type_code:
        input.contract_type_code ?? (input.client_option === 'service' ? (input.my_acting_as === 'business' && input.my_role === 'contractor' ? 'services_business' : 'services_individual') : ''),
      deal_type: 'c2c',
      segment: 'free_c2c',
      negotiation_status: 'draft',
      execution_status: null,
      payment_method: input.payment_method ?? null,
      payment_order: input.payment_order ?? null,
      protected: false,
      uses_platform_template: true,
      jurisdiction: input.jurisdiction ?? 'RU',
      title: input.title ?? '',
      additional_terms: [],
      form_data: input.form_data ?? {},
      warnings: [],
      language: '',
      parties: [
        { id: nextId('cp'), role: input.my_role, profile_id: 'pf-person-1', entity_id: input.my_entity_id ?? null, acting_as: input.my_acting_as },
        {
          id: nextId('cp'),
          role: input.my_role === 'customer' ? 'contractor' : 'customer',
          profile_id: input.counterparty_profile_id ?? 'pf-mock-contractor-1',
          entity_id: null,
          acting_as: 'person',
        },
      ],
      created_at: new Date().toISOString(),
    },
    initiatorRole: input.my_role,
    milestones: [],
    checklistItems: new Map(),
    evidence: new Map(),
    milestoneTimeline: new Map(),
    revisions: [],
    preapproved: [],
    signatureRequests: [],
    frozenVersion: null,
    signatures: [],
    timeline: [{ event_id: nextId('te'), topic: 'contract.drafted', occurred_at: new Date().toISOString(), actor: { role: input.my_role }, subject: { type: 'contract', id }, payload: {} }],
  };
  registry.set(id, record);
  return toApiContract(record);
}

/**
 * ADR-167: пределы ручного ввода дополнительных условий — зеркало
 * `apps.contracts.services.clean_additional_terms`. Мок обязан отвечать тем же
 * `400 additional_terms_invalid` с `context.errors`, иначе форма мастера
 * «проходит» в тестах то, что реальный бэк отвергает.
 */
const ADDITIONAL_TERM_MAX_LENGTH = 2000;
const ADDITIONAL_TERMS_MAX_ITEMS = 20;

function cleanAdditionalTerms(value: string[]): string[] {
  const fail = (field: string, code: string, message: string): never => {
    throw new RealMockError(400, 'additional_terms_invalid', message, {
      errors: [{ field, code, message }],
    });
  };
  if (value.length > ADDITIONAL_TERMS_MAX_ITEMS) {
    fail('additional_terms', 'max_items', `Не больше ${ADDITIONAL_TERMS_MAX_ITEMS} пунктов.`);
  }
  return value.map((item, index) => {
    const text = String(item).trim();
    if (!text) fail(`additional_terms.${index}`, 'required', 'Пункт не может быть пустым.');
    if (text.length > ADDITIONAL_TERM_MAX_LENGTH) {
      fail(`additional_terms.${index}`, 'max_length', `Пункт длиннее ${ADDITIONAL_TERM_MAX_LENGTH} символов.`);
    }
    return text;
  });
}

export function patchContract(id: string, patch: RealContractPatchInput): RealContract {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  // ADR-167: свободный PATCH — только на черновике (как у реального
  // `patch_draft`); после отправки условия добавляет лишь протокол разногласий.
  if (patch.additional_terms !== undefined && record.contract.negotiation_status !== 'draft') {
    throw new RealMockError(409, 'draft_not_editable', 'Договор больше не черновик.');
  }
  record.contract = {
    ...record.contract,
    ...(patch.additional_terms !== undefined
      ? { additional_terms: cleanAdditionalTerms(patch.additional_terms) }
      : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.form_data !== undefined ? { form_data: patch.form_data } : {}),
    ...(patch.payment_method !== undefined ? { payment_method: patch.payment_method } : {}),
    ...(patch.payment_order !== undefined ? { payment_order: patch.payment_order } : {}),
    ...(patch.contract_type_code !== undefined ? { contract_type_code: patch.contract_type_code } : {}),
    ...(patch.language !== undefined ? { language: patch.language } : {}),
  };
  if (patch.counterparty_profile_id !== undefined) {
    const other = record.contract.parties.find((p) => p.role !== record.initiatorRole);
    if (other) other.profile_id = patch.counterparty_profile_id;
  }
  return toApiContract(record);
}

/** Код `invalid_negotiation_transition` — 1:1 с реальным `InvalidTransitionError`
 * (`apps.contracts.api.views._SERVICE_ERROR_STATUS`, `common.fsm`), не выдуманный
 * `invalid_transition` — фронт различает коды ошибок (`ApiError.code`). */
function assertTransition(record: ContractRecord, allowed: string[]): void {
  if (!allowed.includes(record.contract.negotiation_status)) {
    throw new RealMockError(409, 'invalid_negotiation_transition', `Недопустимое действие для статуса ${record.contract.negotiation_status}.`);
  }
}

export function sendContract(id: string): RealContract {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertTransition(record, ['draft']);
  record.contract = { ...record.contract, negotiation_status: 'under_review' };
  return toApiContract(record);
}

/** ADR-104: DELETE /contracts/{id} — только черновик, 204. */
export function deleteContract(id: string): void {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  if (record.contract.negotiation_status !== 'draft') {
    throw new RealMockError(409, 'invalid_state_transition', 'Удалить можно только черновик.');
  }
  registry.delete(id);
}

/** Выход из заморозки (ADR-006, ADR-124 — `_annul_signing_round` на бэке):
 * все pending-заявки раунда → `declined_for_revision`, подписи раунда
 * удаляются, `frozenVersion` снимается (на реальном бэке `ContractVersion`
 * append-only — здесь просто ссылка). Общий для return-for-revision,
 * decline, reject и withdraw. */
function annulSigningRound(record: ContractRecord): void {
  record.signatureRequests = record.signatureRequests.map((s) => (s.status === 'pending' ? { ...s, status: 'declined_for_revision' } : s));
  record.signatures = [];
  record.frozenVersion = null;
}

/** `POST /contracts/{id}/withdraw` (§6.1, ADR-124): и из замороженных
 * состояний — с аннулированием раунда подписания. */
export function withdrawContract(id: string): RealContract {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertTransition(record, ['under_review', 'pending_signature', 'awaiting_signatures']);
  annulSigningRound(record);
  record.contract = { ...record.contract, negotiation_status: 'withdrawn_by_initiator' };
  record.timeline.push({ event_id: nextId('te'), topic: 'negotiation.withdrawn', occurred_at: new Date().toISOString(), actor: {}, subject: { type: 'contract', id }, payload: {} });
  return toApiContract(record);
}

/** `POST /contracts/{id}/reject` (§6.1, ADR-124): и из замороженных
 * состояний — с аннулированием раунда подписания. */
export function rejectContract(id: string): RealContract {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertTransition(record, ['under_review', 'pending_signature', 'awaiting_signatures']);
  annulSigningRound(record);
  record.contract = { ...record.contract, negotiation_status: 'rejected_by_counterparty' };
  record.timeline.push({ event_id: nextId('te'), topic: 'negotiation.rejected', occurred_at: new Date().toISOString(), actor: {}, subject: { type: 'contract', id }, payload: {} });
  return toApiContract(record);
}

/** `POST /contracts/{id}/return-for-revision` (ADR-124): pending_signature /
 * awaiting_signatures -> under_review ЛЮБОЙ стороной, без заявки на подпись
 * (в отличие от `declineSignatureRequest`). Комментарий обязателен (422 —
 * как DRF-валидация `ReturnForRevisionSerializer`). */
export function returnForRevision(id: string, input: { comment?: string }): RealContract {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  const comment = (input.comment ?? '').trim();
  if (!comment) throw new RealMockError(422, 'validation_error', 'Комментарий обязателен.');
  assertTransition(record, ['pending_signature', 'awaiting_signatures']);
  annulSigningRound(record);
  record.contract = { ...record.contract, negotiation_status: 'under_review' };
  record.timeline.push({ event_id: nextId('te'), topic: 'negotiation.reopened', occurred_at: new Date().toISOString(), actor: {}, subject: { type: 'contract', id }, payload: { reason: 'returned_for_revision', comment } });
  return toApiContract(record);
}

export function createMilestone(contractId: string, input: RealMilestoneCreateInput): RealMilestoneTreeNode {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  const m = seedMilestone({
    id: nextId('ms'),
    title: input.title,
    parent_id: input.parent_id ?? null,
    order: input.order ?? record.milestones.length,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    sphere_code: input.sphere_code ?? null,
    deadline: input.deadline ?? null,
    depends_on_id: input.depends_on_id ?? null,
  });
  record.milestones.push(m);
  return buildTreeNode(record, m);
}

export function patchMilestone(milestoneId: string, patch: RealMilestonePatchInput): RealMilestoneTreeNode {
  for (const record of registry.values()) {
    const m = record.milestones.find((x) => x.id === milestoneId);
    if (!m) continue;
    Object.assign(m, patch);
    return buildTreeNode(record, m);
  }
  throw new RealMockError(404, 'not_found', 'Этап не найден.');
}

/** DELETE /milestones/{id} (ADR-101): поддерево и чек-листы — каскадом, как
 * по FK на бэке; после подписания — 409 contract_immutable. */
export function deleteMilestone(milestoneId: string): void {
  for (const record of registry.values()) {
    if (!record.milestones.some((x) => x.id === milestoneId)) continue;
    if (!['draft', 'under_review'].includes(record.contract.negotiation_status)) {
      throw new RealMockError(409, 'contract_immutable', 'Структура этапов редактируется только до подписания.');
    }
    const doomed = new Set<string>([milestoneId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of record.milestones) {
        if (m.parent_id && doomed.has(m.parent_id) && !doomed.has(m.id)) {
          doomed.add(m.id);
          grew = true;
        }
      }
    }
    record.milestones = record.milestones.filter((m) => !doomed.has(m.id));
    for (const id of doomed) {
      record.checklistItems.delete(id);
      materialRegistry.delete(id);
    }
    return;
  }
  throw new RealMockError(404, 'not_found', 'Этап не найден.');
}

export function listChecklistItems(milestoneId: string): RealChecklistItem[] {
  for (const record of registry.values()) {
    if (record.milestones.some((m) => m.id === milestoneId)) return record.checklistItems.get(milestoneId) ?? [];
  }
  throw new RealMockError(404, 'not_found', 'Этап не найден.');
}

export function createChecklistItem(milestoneId: string, input: RealChecklistItemCreateInput): RealChecklistItem {
  for (const record of registry.values()) {
    const m = record.milestones.find((x) => x.id === milestoneId);
    if (!m) continue;
    const item: RealChecklistItem = {
      id: nextId('ci'),
      milestone_id: milestoneId,
      description: input.description,
      measurable_criterion: input.measurable_criterion,
      required_evidence: input.required_evidence ?? [],
      order: input.order ?? (record.checklistItems.get(milestoneId)?.length ?? 0),
      created_at: new Date().toISOString(),
    };
    const list = record.checklistItems.get(milestoneId) ?? [];
    list.push(item);
    record.checklistItems.set(milestoneId, list);
    return item;
  }
  throw new RealMockError(404, 'not_found', 'Этап не найден.');
}

/** Плоский поиск пункта чек-листа + договора-владельца; правка/удаление —
 * только до подписания (409 `contract_immutable`, как `deleteMilestone`). */
function findEditableChecklistItem(itemId: string): { list: RealChecklistItem[]; index: number } {
  for (const record of registry.values()) {
    for (const list of record.checklistItems.values()) {
      const index = list.findIndex((it) => it.id === itemId);
      if (index < 0) continue;
      if (!['draft', 'under_review'].includes(record.contract.negotiation_status)) {
        throw new RealMockError(409, 'contract_immutable', 'Структура этапов редактируется только до подписания.');
      }
      return { list, index };
    }
  }
  throw new RealMockError(404, 'not_found', 'Пункт чек-листа не найден.');
}

/** PATCH /checklist-items/{id} — поля опциональны, отсутствующее не меняется. */
export function patchChecklistItem(itemId: string, patch: RealChecklistItemPatchInput): RealChecklistItem {
  const { list, index } = findEditableChecklistItem(itemId);
  const current = list[index]!;
  const next: RealChecklistItem = {
    ...current,
    description: patch.description ?? current.description,
    measurable_criterion: patch.measurable_criterion ?? current.measurable_criterion,
    required_evidence: patch.required_evidence ?? current.required_evidence,
    order: patch.order ?? current.order,
  };
  list[index] = next;
  return next;
}

/** DELETE /checklist-items/{id} → 204; сам этап остаётся. */
export function deleteChecklistItem(itemId: string): void {
  const { list, index } = findEditableChecklistItem(itemId);
  list.splice(index, 1);
}

/** `GET /milestones/{id}/materials` (`apps.milestones.selectors.list_materials`). */
export function listMaterials(milestoneId: string): RealContractMaterial[] {
  for (const record of registry.values()) {
    if (record.milestones.some((m) => m.id === milestoneId)) return materialRegistry.get(milestoneId) ?? [];
  }
  throw new RealMockError(404, 'not_found', 'Этап не найден.');
}

/** Договор-владелец этапа + проверка «редактируется» (`_assert_editable`):
 * материалы, как и структура этапов, правятся только до подписания. */
function findEditableMilestoneRecord(milestoneId: string): ContractRecord {
  for (const record of registry.values()) {
    if (!record.milestones.some((m) => m.id === milestoneId)) continue;
    if (!['draft', 'under_review'].includes(record.contract.negotiation_status)) {
      throw new RealMockError(409, 'contract_immutable', 'Материалы редактируются только до подписания.');
    }
    return record;
  }
  throw new RealMockError(404, 'not_found', 'Этап не найден.');
}

/** ADR-157 §5: правки материалов свёрнуты в хронику ДОГОВОРА (`nested`,
 * `subject` — этап). Актор — роль правящей стороны: по ней карточка отличает
 * «правил контрагент» от «правил я» (ADR-156, бейдж внимания). */
function pushMaterialEvent(
  record: ContractRecord,
  milestoneId: string,
  topic: 'milestone.material_added' | 'milestone.material_updated' | 'milestone.material_removed',
  actingProfileId?: string,
): void {
  const milestone = record.milestones.find((m) => m.id === milestoneId) ?? null;
  const role = record.contract.parties.find((p) => p.profile_id === actingProfileId)?.role ?? null;
  pushNestedEvent(record, topic, { type: 'milestone', id: milestoneId, title: milestone?.title ?? null }, role);
}

/** `POST /milestones/{id}/materials` — правило цены ADR-047: у материала
 * исполнителя цена > 0, у заказчика может быть 0. */
export function createMaterial(
  milestoneId: string,
  input: RealContractMaterialCreateInput,
  actingProfileId?: string,
): RealContractMaterial {
  const materialRecord = findEditableMilestoneRecord(milestoneId);
  if (!input.catalog_item_code) throw new RealMockError(422, 'validation_error', 'Позиция каталога обязательна.');
  if (!input.description?.trim()) throw new RealMockError(422, 'validation_error', 'Описание материала обязательно.');
  if (!input.unit_price_currency) throw new RealMockError(422, 'validation_error', 'Валюта цены обязательна.');
  if (input.source === 'contractor' && Number(input.unit_price) <= 0) {
    throw new RealMockError(422, 'material_price_required', 'У материала исполнителя цена должна быть больше нуля.');
  }
  const material: RealContractMaterial = {
    id: nextId('mat'),
    milestone_id: milestoneId,
    catalog_item_id: `cat-${input.catalog_item_code}`,
    catalog_item_code: input.catalog_item_code,
    description: input.description,
    external_url: input.external_url || null,
    quantity: input.quantity ?? '0',
    unit: input.unit ?? '',
    unit_price: input.unit_price,
    unit_price_currency: input.unit_price_currency,
    source: input.source,
    delivery_days: input.delivery_days ?? 0,
    delivery_base: input.delivery_base ?? 'contract_signing',
    handed_over_at: null,
    handed_over_by_id: null,
    received: false,
    received_at: null,
    received_by_id: null,
    created_at: new Date().toISOString(),
  };
  const list = materialRegistry.get(milestoneId) ?? [];
  list.push(material);
  materialRegistry.set(milestoneId, list);
  pushMaterialEvent(materialRecord, milestoneId, 'milestone.material_added', actingProfileId);
  return material;
}

/** Плоский поиск материала (как `findEditableChecklistItem`): материал
 * адресуется своим id, договор ищется от него. Зеркало бэка — там
 * `ContractMaterialDetailView` (`materials/<uuid>`, ADR-155) правит и удаляет
 * материал, пока договор редактируется; после подписания — 409
 * `contract_immutable`, поэтому здесь `findEditableMilestoneRecord`. */
function findEditableMaterial(materialId: string): {
  record: ContractRecord;
  milestoneId: string;
  list: RealContractMaterial[];
  index: number;
} {
  for (const [milestoneId, list] of materialRegistry.entries()) {
    const index = list.findIndex((m) => m.id === materialId);
    if (index < 0) continue;
    const record = findEditableMilestoneRecord(milestoneId);
    return { record, milestoneId, list, index };
  }
  throw new RealMockError(404, 'not_found', 'Материал не найден.');
}

/** `PATCH /materials/{id}` — поля опциональны, отсутствующее не меняется. */
export function patchMaterial(
  materialId: string,
  patch: RealContractMaterialPatchInput,
  actingProfileId?: string,
): RealContractMaterial {
  const { record, milestoneId, list, index } = findEditableMaterial(materialId);
  const current = list[index]!;
  const source = patch.source ?? current.source;
  const unitPrice = patch.unit_price ?? current.unit_price;
  if (source === 'contractor' && Number(unitPrice) <= 0) {
    throw new RealMockError(422, 'material_price_required', 'У материала исполнителя цена должна быть больше нуля.');
  }
  const next: RealContractMaterial = {
    ...current,
    catalog_item_code: patch.catalog_item_code ?? current.catalog_item_code,
    catalog_item_id: patch.catalog_item_code ? `cat-${patch.catalog_item_code}` : current.catalog_item_id,
    description: patch.description ?? current.description,
    external_url: patch.external_url ?? current.external_url,
    quantity: patch.quantity ?? current.quantity,
    unit: patch.unit ?? current.unit,
    unit_price: unitPrice,
    unit_price_currency: patch.unit_price_currency ?? current.unit_price_currency,
    source,
    delivery_days: patch.delivery_days ?? current.delivery_days,
    delivery_base: patch.delivery_base ?? current.delivery_base,
  };
  list[index] = next;
  pushMaterialEvent(record, milestoneId, 'milestone.material_updated', actingProfileId);
  return next;
}

/** `DELETE /materials/{id}` → 204. */
export function deleteMaterial(materialId: string, actingProfileId?: string): void {
  const { record, milestoneId, list, index } = findEditableMaterial(materialId);
  list.splice(index, 1);
  pushMaterialEvent(record, milestoneId, 'milestone.material_removed', actingProfileId);
}

/** Плоский поиск материала БЕЗ проверки «договор редактируется»: передача и
 * получение случаются как раз на подписанном договоре. */
function findMaterial(materialId: string): { record: ContractRecord; milestoneId: string; list: RealContractMaterial[]; index: number } {
  for (const [milestoneId, list] of materialRegistry.entries()) {
    const index = list.findIndex((m) => m.id === materialId);
    if (index < 0) continue;
    for (const record of registry.values()) {
      if (record.milestones.some((m) => m.id === milestoneId)) return { record, milestoneId, list, index };
    }
  }
  throw new RealMockError(404, 'not_found', 'Материал не найден.');
}

/**
 * ADR-155 §6: два факта двух РАЗНЫХ сторон. «Передал» — только сторона-
 * ИСТОЧНИК (`material.source`), «получил» — только другая (403
 * `material_handover_wrong_side`), иначе поставщик материалов открывал бы
 * гейт этапа сам себе. Порядок между шагами НЕ обязателен: «получено» можно
 * отметить и без «передано» (владелец 03.09).
 */
function assertHandoverSide(record: ContractRecord, material: RealContractMaterial, actingProfileId: string | undefined, step: 'handed_over' | 'received'): ContractRole {
  const role = assertParty(record, actingProfileId);
  const sourceRole: ContractRole = material.source === 'customer' ? 'customer' : 'contractor';
  const expected = step === 'handed_over' ? sourceRole : sourceRole === 'customer' ? 'contractor' : 'customer';
  if (role !== expected) {
    throw new RealMockError(403, 'material_handover_wrong_side', 'Передачу отмечает поставляющая сторона, получение — принимающая.');
  }
  return role;
}

/** `POST /materials/{id}/handed-over` — идемпотентно (двойной клик, ретрай). */
export function handOverMaterial(materialId: string, actingProfileId: string | undefined): RealContractMaterial {
  const { record, milestoneId, list, index } = findMaterial(materialId);
  const current = list[index]!;
  const role = assertHandoverSide(record, current, actingProfileId, 'handed_over');
  if (current.handed_over_at !== null) return current;
  const next: RealContractMaterial = {
    ...current,
    handed_over_at: new Date().toISOString(),
    handed_over_by_id: actingProfileId ?? null,
  };
  list[index] = next;
  pushMilestoneEvent(record, milestoneId, 'milestone.material_handed_over', role);
  return next;
}

/** `POST /materials/{id}/received` — ровно этот шаг двигает гейт; он же
 * размораживает приостановленный этап (как было до ADR-155). */
export function receiveMaterial(materialId: string, actingProfileId: string | undefined): RealContractMaterial {
  const { record, milestoneId, list, index } = findMaterial(materialId);
  const current = list[index]!;
  const role = assertHandoverSide(record, current, actingProfileId, 'received');
  if (current.received) return current;
  const next: RealContractMaterial = {
    ...current,
    received: true,
    received_at: new Date().toISOString(),
    received_by_id: actingProfileId ?? null,
  };
  list[index] = next;
  pushMilestoneEvent(record, milestoneId, 'milestone.material_received', role);
  const milestone = record.milestones.find((m) => m.id === milestoneId);
  if (milestone && milestone.status === 'suspended' && materialsCondition(milestoneId) === 'met') {
    milestone.status = 'in_progress';
  }
  // ADR-162: полученный материал мог быть последним незакрытым условием.
  if (milestone) tryAutoStartMilestone(record, milestone);
  return next;
}

/** Плоский поиск этапа + его договора-владельца (тот же приём, что
 * `patchMilestone`/`listChecklistItems` выше) — ADR-088 Фаза 5. */
function findMilestone(milestoneId: string): { record: ContractRecord; milestone: MilestoneRecord } {
  for (const record of registry.values()) {
    const m = record.milestones.find((x) => x.id === milestoneId);
    if (m) return { record, milestone: m };
  }
  throw new RealMockError(404, 'not_found', 'Этап не найден.');
}

/** `apps.milestones.selectors.uncovered_required_evidence` (ADR-164): пункты
 * чек-листа этапа, которые просят фото и ни одного файла не получили, в
 * порядке чек-листа. Покрытие — «есть хотя бы одно доказательство, ПРИВЯЗАННОЕ
 * к пункту»: файл, приложенный «к этапу» (`checklist_item_id: null`), пункт не
 * покрывает — та самая ловушка из жалобы 05.09. */
function uncoveredRequiredEvidence(record: ContractRecord, milestoneId: string): string[] {
  const items = (record.checklistItems.get(milestoneId) ?? []).filter((c) => c.required_evidence.length > 0);
  if (items.length === 0) return [];
  const covered = new Set((record.evidence.get(milestoneId) ?? []).map((e) => e.checklist_item_id).filter((id): id is string => !!id));
  return items.map((c) => c.id).filter((id) => !covered.has(id));
}

function toApiMilestone(record: ContractRecord, m: MilestoneRecord): RealMilestone {
  return {
    id: m.id,
    contract_id: record.contract.id,
    parent_id: m.parent_id,
    order: m.order,
    title: m.title,
    status: m.status,
    amount: m.amount,
    amount_currency: m.currency,
    sphere_code: m.sphere_code,
    deadline: m.deadline,
    depends_on_id: m.depends_on_id,
    frozen_days: m.frozen_days,
    started_at: m.started_at,
    submitted_at: m.submitted_at,
    accepted_at: m.accepted_at,
    paid_confirmed_by_customer_at: m.paid_confirmed_by_customer_at,
    paid_confirmed_by_contractor_at: m.paid_confirmed_by_contractor_at,
    created_at: m.created_at,
    uncovered_required_evidence: uncoveredRequiredEvidence(record, m.id),
  };
}

/** `GET /milestones/{id}` — плоский ресурс (ADR-088 Фаза 5), больше полей,
 * чем узел дерева из `buildTree`. */
export function getMilestone(milestoneId: string): RealMilestone {
  const { record, milestone } = findMilestone(milestoneId);
  return toApiMilestone(record, milestone);
}

/** `apps.milestones.services.payment_before_start` — предоплата: КАЖДЫЙ лист
 * оплачивается ДО своего старта (ADR-151/155). */
function paymentBeforeStart(record: ContractRecord): boolean {
  return record.contract.payment_order === 'before_start';
}

/** `apps.milestones.services._financial_condition` (ADR-155 §1).
 *
 * При `before_start` условие ОДНО — оплата ИМЕННО ЭТОГО листа подтверждена
 * обеими сторонами; способ расчёта говорит, по каким рельсам платят, а не
 * когда. Исключение — `direct_platform`/`hold`: партнёра нет, наблюдать
 * платёж нечем (`awaiting_payment`, честная заглушка ADR-130). */
function financialCondition(record: ContractRecord, m: MilestoneRecord): { met: boolean; reason: RealMilestoneGateReason | null } {
  const method = record.contract.payment_method;
  if (paymentBeforeStart(record)) {
    if (method === 'direct_platform' || method === 'hold') return { met: false, reason: 'awaiting_payment' };
    if (!method) return { met: false, reason: 'payment_method_not_set' };
    const ok = m.paid_confirmed_by_customer_at !== null && m.paid_confirmed_by_contractor_at !== null;
    return { met: ok, reason: ok ? null : 'payment_not_confirmed' };
  }
  if (method === 'cash' || method === 'external') return { met: true, reason: null };
  if (method === 'direct_platform' || method === 'hold') return { met: false, reason: 'awaiting_payment' };
  return { met: false, reason: 'payment_method_not_set' };
}

/** Материалы `source=customer` этапа — ровно они держат гейт (domain-model
 * §7.3): материалы исполнителя гейт не блокируют. */
function customerMaterials(milestoneId: string): RealContractMaterial[] {
  return (materialRegistry.get(milestoneId) ?? []).filter((m) => m.source === 'customer');
}

/** `_materials_condition`: `not_required` — у листа НЕТ материалов заказчика,
 * ждать нечего и «Готово» показывать не за что. */
function materialsCondition(milestoneId: string): RealGateConditionState {
  const mine = customerMaterials(milestoneId);
  if (mine.length === 0) return 'not_required';
  return mine.every((m) => m.received) ? 'met' : 'waiting';
}

/** `_financial_condition_state`: `not_required` — только там, где платить ДО
 * старта не надо ВОВСЕ (постоплата/заём на офлайн-рельсах). */
function financialConditionState(record: ContractRecord, met: boolean): RealGateConditionState {
  if (paymentBeforeStart(record)) return met ? 'met' : 'waiting';
  const method = record.contract.payment_method;
  if (method === 'cash' || method === 'external') return 'not_required';
  return met ? 'met' : 'waiting';
}

/** `GET /milestones/{id}/gate` — зеркалит `apps.milestones.services.gate_status`
 * (ADR-155 §5): рядом с булевыми полями — СОСТОЯНИЕ каждого условия строкой.
 * Пока договор не подписан, все три — `waiting` (владелец 03.09): до подписи
 * ни одно из них не «готово», обязательства ещё не возникли. */
export function gateStatus(milestoneId: string): RealMilestoneGateStatus {
  const { record, milestone } = findMilestone(milestoneId);
  const signed = record.contract.negotiation_status === 'signed';
  const financial = financialCondition(record, milestone);
  const materials = materialsCondition(milestoneId);
  const materialsReady = materials !== 'waiting';
  return {
    signed,
    materials_ready: materialsReady,
    financial_condition_met: financial.met,
    financial_condition_reason: financial.reason,
    conditions: signed
      ? { signed: 'met', materials, financial: financialConditionState(record, financial.met) }
      : { signed: 'waiting', materials: 'waiting', financial: 'waiting' },
    can_start: signed && materialsReady && financial.met,
  };
}

/** ADR-162: лист входит в работу САМ в момент закрытия последнего условия
 * гейта — мок обязан воспроизводить это, иначе экран в мок-режиме ведёт себя
 * не так, как в реальном. Тихий no-op, если лист уже не `pending`, если это
 * ветка или если хоть одно условие ещё «Ждём» (у бэка — `_try_auto_start`).
 * Событий два, как у бэка, и оба без актора: старт — решение системы. */
function tryAutoStartMilestone(record: ContractRecord, milestone: MilestoneRecord): void {
  if (milestone.status !== 'pending') return;
  if (!isLeaf(record, milestone.id)) return;
  if (!gateStatus(milestone.id).can_start) return;
  milestone.status = 'in_progress';
  milestone.started_at = new Date().toISOString();
  if (record.contract.execution_status === 'pending_start') record.contract.execution_status = 'in_progress';
  pushMilestoneEvent(record, milestone.id, 'milestone.gate_passed', null);
  pushMilestoneEvent(record, milestone.id, 'milestone.started', null);
}

/** ADR-162, путь «подпись закрыла последнее условие» (у бэка — подписчик
 * `handlers.handle_contract_signed` на `contract.signed`). */
function autoStartReadyLeaves(record: ContractRecord): void {
  for (const milestone of [...record.milestones]) tryAutoStartMilestone(record, milestone);
}

/** Какие события этапа бэк зеркалит в хронику договора (ADR-134) — не все:
 * загрузка доказательств и отметки оплаты остаются в ленте самого этапа. */
const MILESTONE_TOPICS_IN_CONTRACT_TIMELINE = new Set(['milestone.started', 'milestone.submitted', 'milestone.accepted', 'milestone.rejected']);

/** `actorRole = null` — событие СИСТЕМЫ (ADR-162: автостарт листа): пустой
 * актор, как у бэка, — от него же зависит, что уведомление уйдёт обеим
 * сторонам, а не «всем кроме автора». */
function pushMilestoneEvent(record: ContractRecord, milestoneId: string, topic: string, actorRole: ContractRole | null): void {
  const list = record.milestoneTimeline.get(milestoneId) ?? [];
  list.push({
    event_id: nextId('mte'),
    topic,
    occurred_at: new Date().toISOString(),
    actor: actorRole ? { role: actorRole } : {},
    subject: { type: 'milestone', id: milestoneId },
    payload: {},
  });
  record.milestoneTimeline.set(milestoneId, list);
  if (MILESTONE_TOPICS_IN_CONTRACT_TIMELINE.has(topic)) {
    const title = record.milestones.find((m) => m.id === milestoneId)?.title ?? null;
    pushNestedEvent(record, topic, { type: 'milestone', id: milestoneId, title }, actorRole);
  }
}

/** `POST /milestones/{id}/start` — идемпотентно на уже `in_progress`
 * (`services.start_milestone` докстринг), иначе требует `can_start`. */
export function startMilestone(milestoneId: string, callingUserId: string): RealMilestone {
  const { record, milestone } = findMilestone(milestoneId);
  if (milestone.status === 'in_progress') return toApiMilestone(record, milestone);
  if (milestone.status !== 'pending') {
    throw new RealMockError(409, 'invalid_transition', `Этап в статусе ${milestone.status} нельзя начать.`);
  }
  // Коды — как у бэка (`apps.milestones.api.views._SERVICE_ERROR_STATUS`):
  // одна причина — один код, а у финансового отказа она ещё и
  // машиночитаема в `context.reason` (ADR-155 §5).
  const gate = gateStatus(milestoneId);
  if (!gate.signed) throw new RealMockError(409, 'gate_not_signed', 'Договор ещё не подписан.');
  if (!gate.materials_ready) {
    throw new RealMockError(409, 'gate_materials_not_ready', 'Не все материалы заказчика получены.');
  }
  if (!gate.financial_condition_met) {
    throw new RealMockError(409, 'gate_financial_condition_not_met', 'Финансовое условие гейта не выполнено.', {
      reason: gate.financial_condition_reason,
    });
  }
  milestone.status = 'in_progress';
  milestone.started_at = new Date().toISOString();
  const myRole = record.contract.parties.find((p) => OWNER_USER_ID[p.profile_id] === callingUserId)?.role ?? 'contractor';
  pushMilestoneEvent(record, milestoneId, 'milestone.started', myRole);
  return toApiMilestone(record, milestone);
}

/** `POST /milestones/{id}/submit` — «сдача», `in_progress -> under_acceptance`. */
export function submitMilestone(milestoneId: string, input: RealMilestoneSubmitInput, callingUserId: string): RealMilestone {
  const { record, milestone } = findMilestone(milestoneId);
  if (milestone.status !== 'in_progress') {
    throw new RealMockError(409, 'invalid_transition', `Этап в статусе ${milestone.status} нельзя сдать.`);
  }
  milestone.status = 'under_acceptance';
  milestone.submitted_at = new Date().toISOString();
  const myRole = record.contract.parties.find((p) => OWNER_USER_ID[p.profile_id] === callingUserId)?.role ?? 'contractor';
  pushMilestoneEvent(record, milestoneId, 'milestone.submitted', myRole);
  void input; // `comment` — принимается, не хранится мок-стором (то же упрощение, что реальный сериализатор не отдаёт его назад).
  return toApiMilestone(record, milestone);
}

/** Роль вызывающего пользователя по договору-владельцу этапа (тот же приём,
 * что `startMilestone`/`submitMilestone` выше) — `undefined`, если он вообще
 * не сторона (тогда 403 ниже честно совпадает с реальным `NotAPartyError`,
 * которым бэк ошибочно, но реально маркирует и «не та роль» — зеркалим
 * байт-в-байт, не поправляем «на бумаге правильнее»). */
function roleOf(record: ContractRecord, callingUserId: string): ContractRole | undefined {
  return record.contract.parties.find((p) => OWNER_USER_ID[p.profile_id] === callingUserId)?.role;
}

/** `POST /milestones/{id}/accept` — ТОЛЬКО заказчик (`accept_milestone`
 * докстринг), БЕЗ тела. `under_acceptance -> accepted` И `disputed ->
 * accepted` (`MILESTONE_FSM`: «принять всё же» после отклонения — спор сам
 * не разрешается этой веткой API, заглушка, ADR-088 Фаза 6 вне скоупа). */
export function acceptMilestone(milestoneId: string, callingUserId: string): RealMilestone {
  const { record, milestone } = findMilestone(milestoneId);
  if (roleOf(record, callingUserId) !== 'customer') {
    throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора');
  }
  if (milestone.status !== 'under_acceptance' && milestone.status !== 'disputed') {
    throw new RealMockError(409, 'invalid_transition', `Этап в статусе ${milestone.status} нельзя принять.`);
  }
  milestone.status = 'accepted';
  if (!milestone.accepted_at) milestone.accepted_at = new Date().toISOString();
  pushMilestoneEvent(record, milestoneId, 'milestone.accepted', 'customer');
  // ADR-155 §3: при предоплате лист закрывается оплаченным ИМЕННО ЗДЕСЬ —
  // деньги пришли до старта, «принят» без `paid` оставил бы договор
  // незавершаемым (`complete_execution` считает по `paid`).
  if (paymentBeforeStart(record)) settlePaid(record, milestone, 'customer');
  return toApiMilestone(record, milestone);
}

/** `POST /milestones/{id}/reject` — ТОЛЬКО заказчик, ОБЯЗАТЕЛЬНО
 * `checklist_item_id` (свой этап) + непустой `evidence` (ADR-017,
 * `reject_milestone` докстринг — «отклонение только по пункту чек-листа +
 * доказательство»). `under_acceptance -> disputed`. */
export function rejectMilestone(milestoneId: string, checklistItemId: string | null | undefined, evidence: string[], callingUserId: string): RealMilestone {
  const { record, milestone } = findMilestone(milestoneId);
  if (roleOf(record, callingUserId) !== 'customer') {
    throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора');
  }
  if (!checklistItemId) {
    throw new RealMockError(422, 'checklist_item_required', 'Отклонение возможно только по одному пункту чек-листа — укажите пункт');
  }
  const items = record.checklistItems.get(milestoneId) ?? [];
  if (!items.some((c) => c.id === checklistItemId)) {
    throw new RealMockError(422, 'checklist_item_wrong_milestone', 'Пункт чек-листа принадлежит другому этапу.');
  }
  if (!evidence || evidence.length === 0) {
    throw new RealMockError(422, 'evidence_required', 'Отклонение требует хотя бы одно доказательство');
  }
  if (milestone.status !== 'under_acceptance') {
    throw new RealMockError(409, 'invalid_transition', `Этап в статусе ${milestone.status} нельзя отклонить.`);
  }
  milestone.status = 'disputed';
  pushMilestoneEvent(record, milestoneId, 'milestone.rejected', 'customer');
  return toApiMilestone(record, milestone);
}

/** `POST /milestones/{id}/confirm-payment` — двустороннее подтверждение
 * оплаты (`services.confirm_payment`): `side` обязан совпадать с ролью
 * вызывающего (`WrongConfirmationSideError` → 403), оба подтверждения →
 * `accepted -> paid`; когда ВСЕ листья договора `paid` —
 * `complete_execution`: `in_progress -> completed -> warranty` (у бэка
 * warranty наступает сразу же, completed транзитен).
 *
 * Роль здесь — по `actingProfileId` (X-Acting-Profile), с фолбэком на
 * владельца токена: у мока ЕДИНСТВЕННЫЙ токен (`getMe()` — всегда u-1001),
 * а «вторая сторона подтверждает» в тестах выражается переключением актёра —
 * реальный бэк берёт пользователя из токена, здесь заголовок актёра —
 * единственный сигнал «кто действует» (то же ограничение, что у
 * `roleOf`-методов выше, см. его докстринг). */
export function confirmMilestonePayment(milestoneId: string, side: ContractRole, actingProfileId: string | undefined, callingUserId: string): RealMilestone {
  const { record, milestone } = findMilestone(milestoneId);
  const role = record.contract.parties.find((p) => p.profile_id === actingProfileId)?.role ?? roleOf(record, callingUserId);
  if (!role) {
    throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора');
  }
  if (role !== side) {
    throw new RealMockError(403, 'wrong_confirmation_side', 'Нельзя подтвердить за контрагента');
  }
  // ADR-155 §3: проверка «лист принят» — только у ПОСТОПЛАТЫ. При
  // `before_start` платят до старта, лист в норме ещё `pending`.
  if (!paymentBeforeStart(record) && milestone.status !== 'accepted') {
    // Код от Э4.6 сохранён дословно (`_legacy_confirm` в
    // `apps.payments.api.views`): у URL есть клиенты, и переименовывать его
    // код ошибки ради внутренней реорганизации нельзя.
    throw new RealMockError(409, 'invalid_milestone_transition', `Этап в статусе ${milestone.status} нельзя оплатить.`);
  }
  // Порядок как на бэке: доменный гейт ВЫШЕ, потом материализация счёта,
  // потом подтверждение — иначе ошибочный вызов оставлял бы за собой
  // висящий `pending`, которого никто не выставлял.
  const payment = ensurePayment(record, milestone, 'postpayment');
  confirmPaymentRecord(record, payment, role);
  return toApiMilestone(record, milestone);
}

// --- Платёжный контур Э5, волна 1 (ADR-130) ------------------------------
//
// `Payment` — источник правды о деньгах; отметки `paid_confirmed_*_at`
// на этапе остаются ЗЕРКАЛОМ, у которого ровно
// один писатель — `confirmPaymentRecord` ниже (на бэке —
// `apps.payments.services._mirror_into_milestone`). Поэтому в моке нет и не
// должно быть второго пути записи в эти поля: гейт §6.3 и раздел
// `/dashboard/payments` читают зеркало и обязаны совпадать со счётом.

function paymentsOf(contractId: string): PaymentRecord[] {
  const list = paymentRegistry.get(contractId) ?? [];
  paymentRegistry.set(contractId, list);
  return list;
}

function ensurePayment(record: ContractRecord, milestone: MilestoneRecord, kind: RealPaymentKind): PaymentRecord {
  const list = paymentsOf(record.contract.id);
  const existing = list.find((p) => p.milestone_id === milestone.id && p.kind === kind);
  // Идемпотентность выставления — как `UNIQUE (milestone, kind)` в БД, а не
  // память вызывающего: и подписчик события, и «read-repair» на GET, и
  // унаследованный эндпоинт зовут это сколько угодно раз.
  if (existing) return existing;
  const payment: PaymentRecord = {
    id: nextId('rpay'),
    contract_id: record.contract.id,
    milestone_id: milestone.id,
    kind,
    method: (record.contract.payment_method ?? 'cash') as RealPaymentMethod,
    status: 'pending',
    amount: milestone.amount ?? '0.00',
    currency: milestone.currency ?? 'RUB',
    payer_confirmed_at: null,
    payee_confirmed_at: null,
    cancelled_at: null,
    cancel_reason: '',
    overdue_at: null,
    created_at: new Date().toISOString(),
  };
  list.push(payment);
  return payment;
}

/** `apps.payments.services.ensure_contract_payments` (ADR-155 §2): вид платежа
 * на лист ОДИН (`postpayment` — «оплата этапа»), меняется только МОМЕНТ его
 * выставления. При `payment_order=before_start` счёт есть у КАЖДОГО денежного
 * листа сразу после подписания — иначе платить до старта было бы нечем; при
 * постоплате — только у листа, дошедшего до `accepted`/`paid`. */
function ensureContractPayments(record: ContractRecord): PaymentRecord[] {
  const list = paymentsOf(record.contract.id);
  const method = record.contract.payment_method ?? '';
  if (record.contract.negotiation_status !== 'signed' || !TWO_SIDED_METHODS.includes(method)) return list;
  const beforeStart = paymentBeforeStart(record);
  const leaves = record.milestones.filter((m) => m.amount !== null && isLeaf(record, m.id)).sort((a, b) => a.order - b.order);
  for (const leaf of leaves) {
    if (beforeStart || leaf.status === 'accepted' || leaf.status === 'paid') ensurePayment(record, leaf, 'postpayment');
  }
  // Порядок выдачи — `order_by('milestone__order', 'created_at')`.
  const orderOf = (mid: string): number => record.milestones.find((m) => m.id === mid)?.order ?? 0;
  list.sort((a, b) => orderOf(a.milestone_id) - orderOf(b.milestone_id) || a.created_at.localeCompare(b.created_at));
  return list;
}

function sideOfRole(role: ContractRole): RealPaymentSide {
  // Заказчик платит, исполнитель получает — во всех типах договоров каталога
  // (`apps.payments.services.PAYER_ROLE`/`PAYEE_ROLE`).
  return role === 'customer' ? 'payer' : 'payee';
}

function toApiPayment(record: ContractRecord, payment: PaymentRecord, actingProfileId: string | undefined): RealPayment {
  const role = record.contract.parties.find((p) => p.profile_id === actingProfileId)?.role;
  const mySide = role ? sideOfRole(role) : null;
  const confirmedByPayer = payment.payer_confirmed_at !== null;
  const confirmedByPayee = payment.payee_confirmed_at !== null;
  return {
    id: payment.id,
    contract_id: payment.contract_id,
    milestone_id: payment.milestone_id,
    milestone_title: record.milestones.find((m) => m.id === payment.milestone_id)?.title ?? '',
    kind: payment.kind,
    method: payment.method,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    confirmed_by_payer: confirmedByPayer,
    confirmed_by_payee: confirmedByPayee,
    payer_confirmed_at: payment.payer_confirmed_at,
    payee_confirmed_at: payment.payee_confirmed_at,
    cancelled_at: payment.cancelled_at,
    cancel_reason: payment.cancel_reason,
    overdue_at: payment.overdue_at,
    provider: 'manual',
    provider_ref: null,
    my_side: mySide,
    confirmed_by_me: mySide === 'payer' ? confirmedByPayer : mySide === 'payee' ? confirmedByPayee : null,
    created_at: payment.created_at,
  };
}

function findPayment(paymentId: string): { record: ContractRecord; payment: PaymentRecord } {
  for (const [contractId, list] of paymentRegistry) {
    const payment = list.find((p) => p.id === paymentId);
    const record = registry.get(contractId);
    if (payment && record) return { record, payment };
  }
  throw new RealMockError(404, 'not_found', 'Платёж не найден.');
}

function assertParty(record: ContractRecord, actingProfileId: string | undefined): ContractRole {
  const role = record.contract.parties.find((p) => p.profile_id === actingProfileId)?.role;
  if (!role) throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора');
  return role;
}

/** Единственная точка записи денежного зеркала на этап. */
function confirmPaymentRecord(record: ContractRecord, payment: PaymentRecord, role: ContractRole): void {
  const side = sideOfRole(role);
  const mine = side === 'payer' ? payment.payer_confirmed_at : payment.payee_confirmed_at;
  // Повтор той же стороной — no-op, а НЕ 409: двойной клик и ретрай сети не
  // должны выглядеть конфликтом, денежного факта второе нажатие не добавляет.
  if (mine !== null) return;
  if (payment.status === 'confirmed' || payment.status === 'cancelled') {
    throw new RealMockError(409, 'invalid_payment_transition', 'Недопустимое действие для текущего статуса платежа');
  }
  const now = new Date().toISOString();
  if (side === 'payer') payment.payer_confirmed_at = now;
  else payment.payee_confirmed_at = now;
  payment.status = payment.payer_confirmed_at && payment.payee_confirmed_at ? 'confirmed' : side === 'payer' ? 'payer_confirmed' : 'payee_confirmed';

  const milestone = record.milestones.find((m) => m.id === payment.milestone_id);
  if (!milestone) return;
  milestone[role === 'customer' ? 'paid_confirmed_by_customer_at' : 'paid_confirmed_by_contractor_at'] = now;
  pushMilestoneEvent(record, milestone.id, 'milestone.payment_confirmed', role);
  // ADR-155 §3: при предоплате подтверждение НЕ закрывает лист — работа ещё
  // не сдана. `paid` наступает в момент приёмки (`settlePaid` там же).
  if (!paymentBeforeStart(record)) settlePaid(record, milestone, role);
  // ADR-162: при `before_start` вторая отметка закрывает финансовое условие —
  // если остальное готово, лист стартует сам.
  tryAutoStartMilestone(record, milestone);
}

/** `_settle_paid` — общий финал: обе отметки + принятый лист → `paid`, и если
 * оплачены ВСЕ листья, договор уходит в гарантию. Зовут его два места:
 * подтверждение платежа (постоплата) и приёмка (предоплата). */
function settlePaid(record: ContractRecord, milestone: MilestoneRecord, role: ContractRole): void {
  if (!milestone.paid_confirmed_by_customer_at || !milestone.paid_confirmed_by_contractor_at) return;
  if (milestone.status !== 'accepted') return;
  milestone.status = 'paid';
  pushMilestoneEvent(record, milestone.id, 'milestone.paid', role);
  const allLeavesPaid = record.milestones.every((m) => !isLeaf(record, m.id) || m.status === 'paid');
  if (allLeavesPaid) record.contract.execution_status = 'warranty';
}

/** `GET /v1/contracts/{id}/payments` — с «read-repair» материализацией, как
 * на бэке (реле событий — фоновый свип, а карточку открывают сразу после
 * приёмки). */
export function listContractPayments(contractId: string, actingProfileId: string | undefined): { items: RealPayment[] } {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertParty(record, actingProfileId);
  return { items: ensureContractPayments(record).map((p) => toApiPayment(record, p, actingProfileId)) };
}

/** `GET /v1/payments/{id}`. */
export function getRealPayment(paymentId: string, actingProfileId: string | undefined): RealPayment {
  const { record, payment } = findPayment(paymentId);
  assertParty(record, actingProfileId);
  return toApiPayment(record, payment, actingProfileId);
}

/** `POST /v1/payments/{id}/confirm` — сторона выводится из роли вызывающего;
 * явный `side`, если пришёл, обязан с ней совпасть (403 на чужой). */
export function confirmRealPayment(paymentId: string, side: RealPaymentSide | undefined, actingProfileId: string | undefined): RealPayment {
  const { record, payment } = findPayment(paymentId);
  const role = assertParty(record, actingProfileId);
  if (side && side !== sideOfRole(role)) {
    throw new RealMockError(403, 'wrong_confirmation_side', 'Нельзя подтвердить за контрагента');
  }
  confirmPaymentRecord(record, payment, role);
  return toApiPayment(record, payment, actingProfileId);
}

/** `POST /v1/payments/{id}/cancel` — ТОЛЬКО из `pending` и любой стороной. */
export function cancelRealPayment(paymentId: string, reason: string, actingProfileId: string | undefined): RealPayment {
  const { record, payment } = findPayment(paymentId);
  assertParty(record, actingProfileId);
  // ADR-132 + ADR-155: счёт, который является УСЛОВИЕМ ГЕЙТА (оплата до
  // старта), не отменяется — `UNIQUE (milestone, kind)` не даст выставить
  // его заново, и старт этапа остался бы запертым навсегда.
  if (paymentBeforeStart(record)) {
    throw new RealMockError(409, 'payment_not_cancellable', 'Оплата до начала этапа — условие гейта, отмена невозможна.');
  }
  if (payment.status !== 'pending') {
    throw new RealMockError(409, 'invalid_payment_transition', 'Отменить можно только невыставленный к подтверждению счёт');
  }
  payment.status = 'cancelled';
  payment.cancelled_at = new Date().toISOString();
  payment.cancel_reason = reason.slice(0, 255);
  return toApiPayment(record, payment, actingProfileId);
}

/** `GET /milestones/{id}/acceptance` — окно приёмки, детерминированная
 * заглушка «5 дней от сдачи» (реальный бэк считает от `placed_in_cabinet_at`
 * юрканала — здесь для простоты сразу «размещено»). */
export function acceptanceStatus(milestoneId: string): RealMilestoneAcceptanceStatus {
  const { milestone } = findMilestone(milestoneId);
  if (milestone.status !== 'under_acceptance' || !milestone.submitted_at) {
    return { placed_in_cabinet: false, deadline_at: null, hours_left: null };
  }
  const deadline = new Date(new Date(milestone.submitted_at).getTime() + 5 * 24 * 60 * 60 * 1000);
  const hoursLeft = Math.max((deadline.getTime() - Date.now()) / (60 * 60 * 1000), 0);
  return { placed_in_cabinet: true, deadline_at: deadline.toISOString(), hours_left: hoursLeft };
}

/** `GET /milestones/{id}/timeline` — лента конкретного этапа. Тот же
 * сериализатор, что у хроники договора (`apps.milestones.selectors.get_
 * timeline` зовёт `contracts_selectors.timeline_entries`), поэтому элемент
 * проходит через `toApiTimelineEvent`: `kind` + локализованный `title`.
 * Раньше мок отдавал сырой элемент, и экран этапа печатал код события. */
export function listMilestoneTimeline(milestoneId: string): RealTimelineEvent[] {
  const { record } = findMilestone(milestoneId);
  const list = record.milestoneTimeline.get(milestoneId) ?? [];
  return [...list].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map(toApiTimelineEvent);
}

/** `GET /milestones/{id}/evidence`. */
export function listEvidence(milestoneId: string): RealEvidence[] {
  const { record } = findMilestone(milestoneId);
  return record.evidence.get(milestoneId) ?? [];
}

/** Плоский поиск доказательства по id (для `GET /evidence/{id}/thumbnail` —
 * мок всегда `has_thumbnail: false`, реального EXIF-превью не пересчитывает,
 * ADR-088 Фаза 5, вне основного скоупа этой фазы). */
export function getEvidence(evidenceId: string): RealEvidence {
  for (const record of registry.values()) {
    for (const list of record.evidence.values()) {
      const found = list.find((e) => e.id === evidenceId);
      if (found) return found;
    }
  }
  throw new RealMockError(404, 'not_found', 'Доказательство не найдено.');
}

/** `POST /milestones/{id}/evidence` — РЕАЛЬНЫЙ multipart в моке тоже:
 * `realContractsHandlers.ts` читает `request.formData()` и передаёт сюда
 * УЖЕ настоящий `File` (не JSON-метаданные, ADR-088 Фаза 5, ГВ.3).
 * `EVIDENCE_MAX_FILE_SIZE_BYTES` — зеркалит `backend/config/settings/base.py`
 * дефолт (25 МиБ). */
const MOCK_EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

/** `file` — только метаданные (`name`/`type`/`size`), не полный `File`:
 * `realContractsHandlers.ts` парсит multipart сам (`./multipart.ts`, обходит
 * `Request.formData()` — jsdom-тестовое ограничение, см. докстринг файла),
 * мок не хранит реальные байты, как и остальной мок-стор. */
export function uploadEvidence(
  milestoneId: string,
  file: { name: string; type: string; size: number },
  checklistItemId: string | undefined,
  uploadedByUserId: string,
  description = '',
): RealEvidence {
  const { record } = findMilestone(milestoneId);
  if (checklistItemId) {
    const items = record.checklistItems.get(milestoneId) ?? [];
    if (!items.some((c) => c.id === checklistItemId)) {
      throw new RealMockError(422, 'checklist_item_wrong_milestone', 'Пункт чек-листа принадлежит другому этапу.');
    }
  }
  if (file.size > MOCK_EVIDENCE_MAX_BYTES) {
    throw new RealMockError(413, 'evidence_too_large', 'Файл превышает допустимый размер.');
  }
  const item: RealEvidence = {
    id: nextId('ev'),
    contract_id: record.contract.id,
    milestone_id: milestoneId,
    checklist_item_id: checklistItemId ?? null,
    dispute_id: null,
    uploaded_by_id: uploadedByUserId,
    file_name: file.name,
    description,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    file_hash: `${nextId('hash')}`.padEnd(64, '0'),
    trusted_timestamp_at: new Date().toISOString(),
    trusted_timestamp_source: 'mock-tsa',
    has_thumbnail: false,
    metadata: {},
    storage_mode: 'ru',
    delivery_status: 'in_transit',
    delivered_to_counterparty_at: null,
    backup_status: 'not_requested',
    backup_provider: '',
    backup_completed_at: null,
    backup_failure_reason: '',
    backup_drive_file_id: '',
    backup_drive_web_view_link: '',
    created_at: new Date().toISOString(),
  };
  const list = record.evidence.get(milestoneId) ?? [];
  list.push(item);
  record.evidence.set(milestoneId, list);
  const myRole = record.contract.parties.find((p) => OWNER_USER_ID[p.profile_id] === uploadedByUserId)?.role ?? 'contractor';
  pushMilestoneEvent(record, milestoneId, 'evidence.uploaded', myRole);
  return item;
}

export function listRevisions(contractId: string): RealRevisionProposal[] {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  return record.revisions;
}

/** Протокол разногласий (реальный контур, зеркало apps.contracts.services).
 * `_assert_negotiating`: правки — только under_review; свои предложения
 * принять/отклонить нельзя (`own_proposal_decision`); counter закрывает
 * старое `superseded` и открывает встречное. */
function assertNegotiating(record: ContractRecord): void {
  if (record.contract.negotiation_status !== 'under_review') {
    throw new RealMockError(409, 'invalid_negotiation_transition', 'Правки — только на согласовании.');
  }
}

function findRevision(revisionId: string): { record: ContractRecord; revision: RealRevisionProposal } {
  for (const record of registry.values()) {
    const revision = record.revisions.find((r) => r.id === revisionId);
    if (revision) return { record, revision };
  }
  throw new RealMockError(404, 'not_found', 'Предложение не найдено.');
}

export function createRevision(
  contractId: string,
  input: { item_ref: string; new_value: unknown; old_value?: unknown; comment?: string },
  actingProfileId: string,
): RealRevisionProposal {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertNegotiating(record);
  validateRevisionTarget(record, input.item_ref, input.new_value);
  const revision: RealRevisionProposal = {
    id: nextId('rev'),
    contract_id: contractId,
    item_ref: input.item_ref,
    old_value: input.item_ref === 'other' ? null : (input.old_value ?? currentRevisionValue(record, input.item_ref)),
    new_value: input.new_value,
    comment: input.comment ?? '',
    proposed_by_id: actingProfileId,
    status: 'open',
    decided_by_id: null,
    decided_at: null,
    preapproved_alternative_of_id: null,
    created_at: new Date().toISOString(),
  };
  record.revisions.push(revision);
  return revision;
}

export function decideRevision(
  revisionId: string,
  decision: 'accepted' | 'rejected',
  actingProfileId: string,
): RealRevisionProposal {
  const { record, revision } = findRevision(revisionId);
  assertNegotiating(record);
  if (revision.status !== 'open') throw new RealMockError(409, 'revision_not_open', 'Предложение уже закрыто.');
  if (revision.proposed_by_id === actingProfileId) {
    throw new RealMockError(403, 'own_proposal_decision', 'Нельзя решать по собственному предложению.');
  }
  if (decision === 'accepted') applyRevisionValue(record, revision.item_ref, revision.new_value);
  revision.status = decision;
  revision.decided_by_id = actingProfileId;
  revision.decided_at = new Date().toISOString();
  return revision;
}

/** Полевая ошибка 422 в формате `form_data_invalid` бэка (`context.errors`). */
function valueInvalid(field: string, code: string, message: string): RealMockError {
  return new RealMockError(422, 'revision_value_invalid', message, { errors: [{ field, code, message }] });
}

/**
 * ADR-157 — структурные адреса правки (`milestone.<id>.<поле>` /
 * `material.<id>.<поле>`), зеркало `parse_structured_ref`. Неизвестное ПОЛЕ и
 * битый адрес дают `null`, а не ошибку: такой ref остаётся свободной
 * текстовой правкой прежнего образца.
 */
const STRUCTURED_REVISION_FIELDS: Record<string, string[]> = {
  milestone: ['title', 'amount', 'deadline', 'start_gate'],
  material: ['type', 'quantity', 'delivery_days'],
};

interface StructuredRevisionRef {
  kind: 'milestone' | 'material';
  targetId: string;
  field: string;
}

function parseStructuredRef(itemRef: string): StructuredRevisionRef | null {
  for (const kind of ['milestone', 'material'] as const) {
    const prefix = `${kind}.`;
    if (!itemRef.startsWith(prefix)) continue;
    const rest = itemRef.slice(prefix.length);
    const dot = rest.indexOf('.');
    if (dot <= 0) return null;
    const field = rest.slice(dot + 1);
    if (!STRUCTURED_REVISION_FIELDS[kind]?.includes(field)) return null;
    return { kind, targetId: rest.slice(0, dot), field };
  }
  return null;
}

/** Цель не принадлежит договору — «Было» показать не из чего, применять нечего. */
function revisionItemUnknown(): RealMockError {
  return new RealMockError(422, 'revision_item_unknown', 'Этот пункт не относится к этому договору.');
}

function revisionMilestone(record: ContractRecord, id: string): MilestoneRecord {
  const m = record.milestones.find((x) => x.id === id);
  if (!m) throw revisionItemUnknown();
  return m;
}

function revisionMaterial(record: ContractRecord, id: string): RealContractMaterial {
  for (const m of record.milestones) {
    const hit = (materialRegistry.get(m.id) ?? []).find((x) => x.id === id);
    if (hit) return hit;
  }
  throw revisionItemUnknown();
}

/**
 * Разбор значения структурной правки — ОДНА функция и для проверки на
 * предложении, и для применения на принятии (зеркало `_clean_structured_value`):
 * «принято, но не применилось» так же недопустимо, как «принято и упало».
 */
function cleanStructuredValue(record: ContractRecord, ref: StructuredRevisionRef, itemRef: string, value: unknown): unknown {
  const text = typeof value === 'string' ? value.trim() : '';
  if (ref.kind === 'milestone') {
    const milestone = revisionMilestone(record, ref.targetId);
    if (ref.field === 'title') {
      if (!text) throw valueInvalid(itemRef, 'required', 'Название этапа не может быть пустым.');
      if (text.length > 300) throw valueInvalid(itemRef, 'max_length', 'Название длиннее 300 символов.');
      return text;
    }
    if (ref.field === 'amount') {
      // Суммы живут только на ЛИСТЬЯХ: ветки группируют (tech-spec §6.1).
      if (record.milestones.some((c) => c.parent_id === milestone.id)) {
        throw valueInvalid(itemRef, 'not_a_leaf', 'Сумма задаётся на конечном этапе.');
      }
      const pair = value as { amount?: unknown; currency?: unknown } | null;
      const rawAmount = pair && typeof pair === 'object' ? pair.amount : value;
      let currency = milestone.currency ?? totalLeafAmount(record)?.currency ?? null;
      if (pair && typeof pair === 'object') {
        const given = typeof pair.currency === 'string' ? pair.currency.trim().toUpperCase() : '';
        if (!given) throw valueInvalid(itemRef, 'currency_required', 'У суммы должна быть валюта.');
        if (currency && given !== currency) {
          throw valueInvalid(itemRef, 'currency_mismatch', 'Валюта не совпадает с валютой договора.');
        }
        currency = given;
      }
      if (!currency) throw valueInvalid(itemRef, 'currency_required', 'У договора ещё нет валюты.');
      const amount = Number(String(rawAmount ?? '').replace(',', '.'));
      if (!Number.isFinite(amount)) throw valueInvalid(itemRef, 'invalid', 'Сумма не число.');
      if (amount < 0) throw valueInvalid(itemRef, 'negative', 'Сумма не может быть отрицательной.');
      return { amount: amount.toFixed(2), currency };
    }
    if (ref.field === 'deadline') {
      if (!text || Number.isNaN(Date.parse(text))) throw valueInvalid(itemRef, 'invalid', 'Срок не в формате ISO 8601.');
      return text;
    }
    // start_gate — это `depends_on` (ADR-157 §1): пусто = условия нет.
    if (!text) return null;
    if (text === milestone.id) throw valueInvalid(itemRef, 'self_reference', 'Этап не может зависеть сам от себя.');
    return revisionMilestone(record, text).id;
  }

  revisionMaterial(record, ref.targetId);
  if (ref.field === 'type') {
    if (!text) throw valueInvalid(itemRef, 'required', 'Тип материала не может быть пустым.');
    if (!materialCatalog.some((c) => c.ref === text)) {
      throw valueInvalid(itemRef, 'unknown_catalog_item', 'Позиции нет в каталоге материалов.');
    }
    return text;
  }
  const num = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(num)) throw valueInvalid(itemRef, 'invalid', 'Значение не число.');
  if (ref.field === 'quantity') {
    if (num <= 0) throw valueInvalid(itemRef, 'not_positive', 'Количество должно быть больше нуля.');
    return String(num);
  }
  if (!Number.isInteger(num)) throw valueInvalid(itemRef, 'invalid', 'Срок поставки не целое число.');
  if (num < 0) throw valueInvalid(itemRef, 'negative', 'Срок поставки не может быть отрицательным.');
  return num;
}

/** «Было» структурного адреса — тем же видом, каким его принимает правка. */
function structuredCurrentValue(record: ContractRecord, ref: StructuredRevisionRef): unknown {
  if (ref.kind === 'milestone') {
    const m = record.milestones.find((x) => x.id === ref.targetId);
    if (!m) return null;
    if (ref.field === 'title') return m.title;
    if (ref.field === 'amount') return m.amount && m.currency ? { amount: m.amount, currency: m.currency } : null;
    if (ref.field === 'deadline') return m.deadline;
    return m.depends_on_id;
  }
  for (const m of record.milestones) {
    const hit = (materialRegistry.get(m.id) ?? []).find((x) => x.id === ref.targetId);
    if (!hit) continue;
    if (ref.field === 'type') return hit.catalog_item_code;
    if (ref.field === 'quantity') return hit.quantity;
    return hit.delivery_days;
  }
  return null;
}

/** Применение структурной правки — те же поля, что правит сторона руками. */
function applyStructuredValue(record: ContractRecord, ref: StructuredRevisionRef, itemRef: string, value: unknown): void {
  const cleaned = cleanStructuredValue(record, ref, itemRef, value);
  if (ref.kind === 'milestone') {
    const m = revisionMilestone(record, ref.targetId);
    if (ref.field === 'title') m.title = cleaned as string;
    else if (ref.field === 'amount') {
      const money = cleaned as { amount: string; currency: string };
      m.amount = money.amount;
      m.currency = money.currency;
    } else if (ref.field === 'deadline') m.deadline = cleaned as string;
    else m.depends_on_id = cleaned as string | null;
    return;
  }
  const material = revisionMaterial(record, ref.targetId);
  if (ref.field === 'type') {
    material.catalog_item_code = cleaned as string;
    material.catalog_item_id = `cat-${cleaned as string}`;
  } else if (ref.field === 'quantity') material.quantity = cleaned as string;
  else material.delivery_days = cleaned as number;
}

/**
 * ADR-123, зеркало `_validate_revision_target`: `form.<key>` — только ключ
 * схемы типа (нет схемы у типа → тоже `revision_item_unknown`), `other` —
 * непустая строка, `title` — строка не длиннее 300.
 */
function validateRevisionTarget(record: ContractRecord, itemRef: string, newValue: unknown): void {
  if (newValue === null || newValue === undefined) {
    throw valueInvalid(itemRef, 'required', 'Значение правки не может быть пустым.');
  }
  if (itemRef.startsWith('form.')) {
    if (!formSchemaHasField(record.contract.contract_type_code, itemRef.slice(5))) {
      throw new RealMockError(422, 'revision_item_unknown', 'Такого поля нет в форме этого типа договора.');
    }
    return;
  }
  if (itemRef === 'other') {
    if (typeof newValue !== 'string' || !newValue.trim()) {
      throw valueInvalid(itemRef, 'required', 'Текст дополнительного условия не может быть пустым.');
    }
    return;
  }
  if (itemRef === 'title') {
    if (typeof newValue !== 'string') throw valueInvalid(itemRef, 'invalid_type', 'Ожидалась строка.');
    if (newValue.length > 300) throw valueInvalid(itemRef, 'max_length', 'Название длиннее 300 символов.');
    return;
  }
  // ADR-157: этапы и материалы проверяются на ПРЕДЛОЖЕНИИ — иначе сторона
  // согласовала бы правку, которую нельзя применить.
  const structured = parseStructuredRef(itemRef);
  if (structured) cleanStructuredValue(record, structured, itemRef, newValue);
  // Прочие («свободные») адреса бэк принимает и не применяет — мок так же.
}

/** ADR-123/157: «Было» из текущего договора — `title` / `form.<key>` /
 * оплата / этап / материал; прочее — null. */
function currentRevisionValue(record: ContractRecord, itemRef: string): unknown {
  if (itemRef === 'title') return record.contract.title;
  if (itemRef.startsWith('form.')) return record.contract.form_data[itemRef.slice(5)] ?? null;
  if (itemRef === 'payment.method') return record.contract.payment_method;
  if (itemRef === 'payment.order') return record.contract.payment_order;
  const structured = parseStructuredRef(itemRef);
  if (structured) return structuredCurrentValue(record, structured);
  return null;
}

/** ADR-123/157: принятая правка ПРИМЕНЯЕТСЯ к договору (зеркало
 * `_apply_revision_value`): `form.<key>` → form_data (мягкое приведение по типу
 * поля схемы), `title` → название, `other` → дописывается в additional_terms,
 * `payment.*` → поля договора, `milestone.*`/`material.*` → этап и материал;
 * свободные адреса не применяются. */
function applyRevisionValue(record: ContractRecord, itemRef: string, value: unknown): void {
  const c = record.contract;
  if (itemRef === 'title') {
    if (typeof value !== 'string' || !value.trim()) throw valueInvalid('title', 'required', 'Название не может быть пустым.');
    c.title = value.trim();
    return;
  }
  if (itemRef === 'other') {
    if (typeof value !== 'string' || !value.trim()) throw valueInvalid('other', 'required', 'Текст условия не может быть пустым.');
    c.additional_terms = [...c.additional_terms, value.trim()];
    return;
  }
  if (!itemRef.startsWith('form.')) {
    // ADR-157: оплата, этапы и материалы применяются так же, как поля формы.
    if (itemRef === 'payment.method') {
      c.payment_method = value as RealContract['payment_method'];
      return;
    }
    if (itemRef === 'payment.order') {
      c.payment_order = value as RealContract['payment_order'];
      return;
    }
    const structured = parseStructuredRef(itemRef);
    if (structured) applyStructuredValue(record, structured, itemRef, value);
    return;
  }
  const key = itemRef.slice(5);
  const type = formSchemaFieldType(c.contract_type_code, key);
  let coerced: unknown = value;
  if (type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) coerced = Number.parseInt(value, 10);
  if (type === 'boolean' && typeof value === 'string') coerced = ['true', '1', 'yes', 'да'].includes(value.trim().toLowerCase());
  if (type === 'decimal' && typeof value === 'number') coerced = String(value);
  c.form_data = { ...c.form_data, [key]: coerced };
}

export function counterRevision(
  revisionId: string,
  input: { new_value: unknown; comment?: string },
  actingProfileId: string,
): RealRevisionProposal {
  const { record, revision } = findRevision(revisionId);
  assertNegotiating(record);
  if (revision.status !== 'open') throw new RealMockError(409, 'revision_not_open', 'Предложение уже закрыто.');
  if (revision.proposed_by_id === actingProfileId) {
    throw new RealMockError(403, 'own_proposal_decision', 'Встречное — только на чужое предложение.');
  }
  // Значение проверяем ДО смены статуса: у бэка это одна транзакция, и
  // отвергнутая встречная не должна оставлять исходную правку закрытой.
  validateRevisionTarget(record, revision.item_ref, input.new_value);
  revision.status = 'superseded';
  revision.decided_by_id = actingProfileId;
  revision.decided_at = new Date().toISOString();
  return createRevision(
    record.contract.id,
    { item_ref: revision.item_ref, old_value: revision.new_value, new_value: input.new_value, comment: input.comment },
    actingProfileId,
  );
}

export function acceptAllRevisions(
  contractId: string,
  confirmSummary: boolean,
  actingProfileId: string,
): RealRevisionProposal[] {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertNegotiating(record);
  const open = record.revisions.filter((r) => r.status === 'open' && r.proposed_by_id !== actingProfileId);
  // Финансовая значимость в моке — числовое new_value (зеркало
  // `_is_financially_significant` по духу: деньги/цифры требуют сводку).
  const significant = open.some((r) => !Number.isNaN(Number(String(r.new_value).replace(',', '.'))) && String(r.new_value).trim() !== '');
  if (significant && !confirmSummary) {
    throw new RealMockError(422, 'confirm_summary_required', 'Финансово значимые правки требуют подтверждения.');
  }
  const now = new Date().toISOString();
  for (const r of open) applyRevisionValue(record, r.item_ref, r.new_value);
  for (const r of open) {
    r.status = 'accepted';
    r.decided_by_id = actingProfileId;
    r.decided_at = now;
  }
  return open;
}

export function listPreapproved(contractId: string): RealPreapprovedAlternative[] {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  return record.preapproved;
}

export function listSignatureRequests(contractId: string): RealSignatureRequest[] {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  return record.signatureRequests;
}

/** Подписи хроники, которые на реальном бэке (ADR-134, решение владельца
 * 26.08) локализуются по языку пользователя и приходят полем `title`. Мок —
 * только ru: фронт словаря по `kind` не ведёт, ему нужен готовый текст. */
const MOCK_TIMELINE_TITLES: Record<string, string> = {
  'contract.drafted': 'Черновик создан',
  'contract.draft_patched': 'Черновик изменён',
  'contract.draft_deleted': 'Черновик удалён',
  'contract.signed': 'Договор подписан обеими сторонами',
  'contract.amended': 'Заключено дополнительное соглашение',
  'contract.started': 'Исполнение начато',
  'contract.completed': 'Исполнение завершено',
  'contract.warranty_started': 'Начался гарантийный период',
  'contract.closed': 'Договор закрыт',
  'contract.terminated': 'Договор расторгнут',
  'contract.terminated.by_customer': 'Договор расторгнут заказчиком',
  'contract.terminated.by_contractor': 'Договор расторгнут исполнителем',
  'negotiation.sent': 'Отправлен контрагенту на согласование',
  'negotiation.withdrawn': 'Отозван инициатором',
  'negotiation.rejected': 'Отклонён контрагентом',
  'negotiation.reopened': 'Возвращён на доработку',
  'negotiation.reopened.returned': 'Возвращён инициатором на доработку',
  'negotiation.reopened.declined': 'Подписант отклонил подписание — возвращён на доработку',
  'negotiation.revised.proposed': 'Предложена правка',
  'negotiation.revised.accepted': 'Правка принята',
  'negotiation.revised.rejected': 'Правка отклонена',
  'negotiation.revised.countered': 'Встречная правка',
  'negotiation.revised.accept_all': 'Приняты все правки',
  'negotiation.revised.alternative': 'Предсогласованная альтернатива',
  'negotiation.frozen': 'Текст договора зафиксирован для подписания',
  'negotiation.signature_requested': 'Направлен запрос на подпись',
  'negotiation.signed': 'Подписан одной стороной',
  'negotiation.signature_forwarded': 'Запрос на подпись переадресован',
  'negotiation.signature_request_expired': 'Срок запроса на подпись истёк',
  'deadline.warranty_expired': 'Гарантийный срок истёк',
  'deadline.termination_window_closed': 'Окно оспаривания расторжения закрыто',
  'milestone.started': 'Этап начат',
  'milestone.submitted': 'Этап сдан на приёмку',
  'milestone.accepted': 'Этап принят',
  'milestone.auto_accepted': 'Этап принят автоматически по истечении срока приёмки',
  'milestone.rejected': 'Этап отклонён',
  'amendment.drafted': 'Допсоглашение создано',
  'amendment.sent': 'Допсоглашение отправлено на согласование',
  'amendment.frozen': 'Версия зафиксирована',
  'amendment.signature_requested': 'Запрошена подпись стороны',
  'amendment.signed': 'Сторона подписала',
  'amendment.signature_forwarded': 'Заявка на подпись переадресована',
  'amendment.signature_request_expired': 'Срок заявки на подпись истёк',
  'amendment.reopened': 'Возвращено на доработку',
  'amendment.rejected': 'Отклонено второй стороной',
  'amendment.withdrawn': 'Отозвано инициатором',
  // ADR-156/157: правки материалов подписаны теми же ключами
  // `ui.timeline.milestone.material_*`, что и в l10n-паках бэка.
  'milestone.material_added': 'Материал добавлен',
  'milestone.material_updated': 'Материал изменён',
  'milestone.material_removed': 'Материал удалён',
  'dispute.opened': 'Открыт спор',
  'dispute.resolved': 'Спор разрешён',
  'payment.paid': 'Оплата подтверждена обеими сторонами',
  'warranty.claim_submitted': 'Подана гарантийная претензия',
  'warranty.claim_declined': 'Гарантийная претензия отклонена',
  'warranty.claim_resolved': 'Гарантийная претензия урегулирована',
};

/** Английский демо-набор витрины (`demoEn.ts`): подписи хроники — данные
 * мока, а не i18n-ключи фронта, поэтому переводятся здесь. Без флага — no-op. */
applyDemoEn(MOCK_TIMELINE_TITLES);

/** Сериализация элемента хроники как на бэке (ADR-134): `kind` = `topic`,
 * `nested` — событие дочерней сущности, `title`/`detail` — готовые подписи
 * (сид может задать свои). Неизвестный `kind` уезжает без `title` — фронт
 * покажет нейтральное «Событие» + код. */
function mockTimelineKind(e: RealTimelineEvent): string {
  if (e.kind) return e.kind;
  // `events.timeline_kind`: многозначный topic → суффикс по payload
  // (здесь только `negotiation.reopened`, единственный, что мок публикует).
  const reason = (e.payload as { reason?: string } | null)?.reason;
  if (e.topic === 'negotiation.reopened' && reason === 'returned_for_revision') return 'negotiation.reopened.returned';
  if (e.topic === 'negotiation.reopened' && reason === 'declined_for_revision') return 'negotiation.reopened.declined';
  return e.topic;
}

function toApiTimelineEvent(e: RealTimelineEvent): RealTimelineEvent {
  const kind = mockTimelineKind(e);
  return {
    ...e,
    kind,
    nested: e.nested ?? e.subject.type !== 'contract',
    title: e.title ?? MOCK_TIMELINE_TITLES[kind] ?? null,
    detail: e.detail ?? null,
  };
}

/** Событие дочерней сущности в хронике ДОГОВОРА (ADR-134): бэк подмешивает
 * события этапов/допников/споров в `GET /contracts/{id}/timeline` с
 * `nested: true` и `subject` этой сущности. */
function pushNestedEvent(record: ContractRecord, topic: string, subject: RealTimelineEvent['subject'], actorRole: ContractRole | null, detail: string | null = null): void {
  record.timeline.push({
    event_id: nextId('te'),
    topic,
    nested: true,
    detail,
    occurred_at: new Date().toISOString(),
    actor: actorRole ? { role: actorRole } : {},
    subject,
    payload: {},
  });
}

export function listTimeline(contractId: string): RealTimelineEvent[] {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  // Бэк отдаёт `order_by("occurred_at")` — сид может лежать не по порядку.
  return [...record.timeline].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map(toApiTimelineEvent);
}

// ═══════════════════════════════════ Заморозка + подписание (Фаза 4, ADR-088) ═

/** Заявка — либо договорная, либо допника (`amendment` непуст) — та же
 * развилка по `SignatureRequest.amendment_id`, что в `api/views.py`. */
function findRecordBySignatureRequestId(signatureRequestId: string): { record: ContractRecord; sigReq: RealSignatureRequest; amendment?: AmendmentRecord } {
  for (const record of registry.values()) {
    const sigReq = record.signatureRequests.find((s) => s.id === signatureRequestId);
    if (sigReq) return { record, sigReq };
  }
  for (const amendment of amendmentRegistry.values()) {
    const sigReq = amendment.signatureRequests.find((s) => s.id === signatureRequestId);
    if (sigReq) {
      const record = registry.get(amendment.amendment.contract_id);
      if (!record) break;
      return { record, sigReq, amendment };
    }
  }
  throw new RealMockError(404, 'not_found', 'Запрос подписи не найден.');
}

/** `apps.contracts.services.freeze_contract` (`POST /contracts/{id}/freeze`):
 * `under_review -> pending_signature`, требует непустое дерево этапов
 * (`EmptyMilestoneTreeError` -> 422 `leaf_sum_mismatch` на реальном бэке —
 * тот же код, что несовпадение сумм, «нечего замораживать» — тот же смысл). */
export function freezeContract(id: string): RealContractVersion {
  const record = registry.get(id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertTransition(record, ['under_review']);
  const hasLeaf = record.milestones.some((m) => isLeaf(record, m.id) && m.amount !== null);
  if (!hasLeaf) throw new RealMockError(422, 'leaf_sum_mismatch', 'Дерево этапов пусто — нечего замораживать.');
  const versionId = nextId('cv');
  const now = new Date().toISOString();
  const hash = versionId.padEnd(64, '0');
  const version: RealContractVersion = {
    id: versionId,
    contract_id: id,
    snapshot: { title: record.contract.title, milestones: buildTree(id) },
    integrity_hash: hash,
    hash_algorithm: 'sha256',
    frozen_at: now,
    trusted_timestamp_source: 'mock-tsa',
    trusted_timestamp_at: now,
    official_language: record.contract.language || 'ru',
    renders: { [record.contract.language || 'ru']: { language: record.contract.language || 'ru', hash, document: {} } },
  };
  record.frozenVersion = version;
  record.contract = { ...record.contract, negotiation_status: 'pending_signature' };
  record.timeline.push({
    event_id: nextId('te'),
    // `negotiation.frozen` — 1:1 с реальным `outbox.publish` в `freeze_contract`
    // (`apps.contracts.services`); `version_id` в payload — как на бэке,
    // хотя фронт теперь берёт id заморозки из `contract.frozen_version_id`.
    topic: 'negotiation.frozen',
    occurred_at: now,
    actor: {},
    subject: { type: 'contract', id },
    payload: { version_id: versionId, integrity_hash: hash, segment: record.contract.segment },
  });
  return version;
}

/** `GET /contracts/{id}/versions/{version_id}` — ETag = `integrity_hash`
 * (заголовок ставит хендлер, не эта функция — тот же приём, что реальный
 * `ContractVersionDetailView`). */
export function getContractVersion(contractId: string, versionId: string): RealContractVersion {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  if (record.frozenVersion && record.frozenVersion.id === versionId) return record.frozenVersion;
  // Версия допника — ТА ЖЕ таблица `ContractVersion` (`contract_id` договора),
  // читается тем же `GET /contracts/{id}/versions/{vid}`.
  for (const a of amendmentRegistry.values()) {
    if (a.amendment.contract_id === contractId && a.frozenVersion?.id === versionId) return a.frozenVersion;
  }
  throw new RealMockError(404, 'not_found', 'Версия не найдена.');
}

/** `GET /contracts/{id}/signatories?side=` — `apps.contracts.services.
 * list_signatories`: business-сторона — ВСЕГДА пустой список (SigningAuthority
 * не смёржен, Р1) — не выдумываем подписанта, честно показываем пустоту в UI. */
export function listSignatories(contractId: string, side: string): RealSignatoryOption[] {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  const party = record.contract.parties.find((p) => p.role === side);
  if (!party || party.acting_as === 'business') return [];
  const userId = OWNER_USER_ID[party.profile_id];
  if (!userId) return [];
  return [{ user_id: userId, basis: 'person' }];
}

/** `POST /contracts/{id}/signature-requests` — `apps.contracts.services.
 * route_signatory`. Один pending-запрос на сторону одновременно
 * (`SignatureRequestAlreadyPendingError` -> 409 `signature_request_already_pending`);
 * `version_id` должен совпасть с ТЕКУЩЕЙ заморозкой (`StaleVersionError` ->
 * 409 `version_stale`) — та же защита от «устарело», что и на `sign`. */
export function createSignatureRequest(contractId: string, input: RealSignatureRequestCreateInput): RealSignatureRequest {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  assertTransition(record, ['pending_signature', 'awaiting_signatures']);
  if (!record.frozenVersion || record.frozenVersion.id !== input.version_id) {
    throw new RealMockError(409, 'version_stale', 'Версия договора устарела.');
  }
  if (record.signatureRequests.some((s) => s.side === input.side && s.status === 'pending')) {
    throw new RealMockError(409, 'signature_request_already_pending', 'У этой стороны уже есть незакрытый запрос подписи.');
  }
  const party = record.contract.parties.find((p) => p.role === input.side);
  const routedBy = party ? (OWNER_USER_ID[party.profile_id] ?? input.signatory_user_id) : input.signatory_user_id;
  const sigReq: RealSignatureRequest = {
    id: nextId('sr'),
    contract_id: contractId,
    amendment_id: null,
    version_id: input.version_id,
    side: input.side,
    routed_by_id: routedBy,
    signatory_id: input.signatory_user_id,
    status: 'pending',
    sent_at: new Date().toISOString(),
    expires_at: null,
    comment: input.comment ?? '',
    locale: '',
  };
  record.signatureRequests = [sigReq, ...record.signatureRequests];
  record.contract = { ...record.contract, negotiation_status: 'awaiting_signatures' };
  record.timeline.push({ event_id: nextId('te'), topic: 'negotiation.signature_requested', occurred_at: sigReq.sent_at, actor: {}, subject: { type: 'contract', id: contractId }, payload: { side: input.side } });
  return sigReq;
}

/** `POST /signature-requests/{id}/sign` — `apps.contracts.services.sign`.
 * `callingUserId` — текущий залогиненный ПОЛЬЗОВАТЕЛЬ (не X-Acting-Profile,
 * `_assert_is_signatory` сверяет по `request.user.id`, реальный бэк тоже не
 * смотрит на acting-профиль здесь). Вторая подпись — ОДНА операция:
 * `negotiation_status='signed'` + `execution_status='pending_start'`. */
export function signSignatureRequest(signatureRequestId: string, input: RealSignInput, callingUserId: string): RealSignature {
  const { record, sigReq, amendment } = findRecordBySignatureRequestId(signatureRequestId);
  if (sigReq.signatory_id !== callingUserId) {
    throw new RealMockError(403, 'not_the_signatory', 'Вы не адресат этого запроса подписи.');
  }
  if (sigReq.status !== 'pending') {
    throw new RealMockError(409, 'signature_request_not_pending', 'Запрос подписи уже разрешён.');
  }
  if (amendment) return signAmendmentRequest(record, amendment, sigReq, input);
  if (!record.frozenVersion || record.frozenVersion.integrity_hash !== input.version_hash) {
    throw new RealMockError(409, 'version_stale', 'Версия договора устарела.');
  }
  sigReq.status = 'signed';
  sigReq.locale = record.contract.language || 'ru';
  const party = record.contract.parties.find((p) => p.role === sigReq.side);
  const signature: RealSignature = {
    id: nextId('sig'),
    contract_id: record.contract.id,
    amendment_id: null,
    version_hash: input.version_hash,
    side: sigReq.side,
    signatory_id: sigReq.signatory_id,
    signed_at: new Date().toISOString(),
    signature_basis: party?.acting_as === 'business' ? 'business' : 'person',
  };
  sigReq.signed_at = signature.signed_at;
  record.signatures.push(signature);
  const sides = new Set(record.contract.parties.map((p) => p.role));
  const signedSides = new Set(record.signatures.map((s) => s.side));
  if ([...sides].every((s) => signedSides.has(s))) {
    record.contract = { ...record.contract, negotiation_status: 'signed', execution_status: 'pending_start' };
    record.timeline.push({ event_id: nextId('te'), topic: 'contract.signed', occurred_at: signature.signed_at, actor: {}, subject: { type: 'contract', id: record.contract.id }, payload: {} });
    // ADR-162: подпись — последнее недостающее условие для листьев без
    // материалов заказчика и без оплаты до старта.
    autoStartReadyLeaves(record);
  } else {
    record.timeline.push({ event_id: nextId('te'), topic: 'negotiation.signed', occurred_at: signature.signed_at, actor: {}, subject: { type: 'contract', id: record.contract.id }, payload: { side: sigReq.side } });
  }
  return signature;
}

/** `POST /signature-requests/{id}/forward` — переадресация: содержимое не
 * меняется, но `awaiting_signatures -> pending_signature` — новый подписант
 * выбирается повторным `createSignatureRequest`. */
export function forwardSignatureRequest(signatureRequestId: string, input: RealForwardSignatureRequestInput, callingUserId: string): RealSignatureRequest {
  const { record, sigReq, amendment } = findRecordBySignatureRequestId(signatureRequestId);
  if (sigReq.signatory_id !== callingUserId) {
    throw new RealMockError(403, 'not_the_signatory', 'Вы не адресат этого запроса подписи.');
  }
  if (sigReq.status !== 'pending') {
    throw new RealMockError(409, 'signature_request_not_pending', 'Запрос подписи уже разрешён.');
  }
  if (amendment) {
    assertAmendmentStatus(amendment, ['awaiting_signatures']);
    sigReq.status = 'forwarded';
    if (input.comment) sigReq.comment = input.comment;
    amendment.amendment.negotiation_status = 'pending_signature';
    pushAmendmentEvent(amendment, 'amendment.signature_forwarded', { signature_request_id: sigReq.id, side: sigReq.side });
    return sigReq;
  }
  assertTransition(record, ['awaiting_signatures']);
  sigReq.status = 'forwarded';
  if (input.comment) sigReq.comment = input.comment;
  record.contract = { ...record.contract, negotiation_status: 'pending_signature' };
  record.timeline.push({ event_id: nextId('te'), topic: 'negotiation.signature_forwarded', occurred_at: new Date().toISOString(), actor: {}, subject: { type: 'contract', id: record.contract.id }, payload: { side: sigReq.side } });
  return sigReq;
}

/** `POST /signature-requests/{id}/decline` — все pending-запросы и подписи
 * текущего раунда аннулируются, `-> under_review`. `frozenVersion` снимается
 * (append-only история версий на реальном бэке — здесь просто ссылка), новая
 * заморозка создаст новую версию. */
export function declineSignatureRequest(signatureRequestId: string, input: RealDeclineSignatureRequestInput, callingUserId: string): RealContract | RealAmendment {
  const { record, sigReq, amendment } = findRecordBySignatureRequestId(signatureRequestId);
  if (sigReq.signatory_id !== callingUserId) {
    throw new RealMockError(403, 'not_the_signatory', 'Вы не адресат этого запроса подписи.');
  }
  if (sigReq.status !== 'pending') {
    throw new RealMockError(409, 'signature_request_not_pending', 'Запрос подписи уже разрешён.');
  }
  if (amendment) {
    // `decline_amendment_for_revision`: аннулируется раунд ДОПНИКА (его
    // заявки/подписи, не договорные), ответ — `AmendmentSerializer`.
    assertAmendmentStatus(amendment, ['awaiting_signatures']);
    amendment.signatureRequests = amendment.signatureRequests.map((r) => (r.status === 'pending' ? { ...r, status: 'declined_for_revision' } : r));
    amendment.signatures = [];
    amendment.frozenVersion = null;
    amendment.amendment.negotiation_status = 'under_review';
    pushAmendmentEvent(amendment, 'amendment.reopened', { reason: 'declined_for_revision', comment: input.comment });
    return toApiAmendment(amendment);
  }
  assertTransition(record, ['awaiting_signatures']);
  annulSigningRound(record);
  record.contract = { ...record.contract, negotiation_status: 'under_review' };
  record.timeline.push({ event_id: nextId('te'), topic: 'negotiation.reopened', occurred_at: new Date().toISOString(), actor: {}, subject: { type: 'contract', id: record.contract.id }, payload: { reason: 'declined_for_revision', comment: input.comment } });
  return toApiContract(record);
}

// ═══════════════════════════════════ Допники (Э4.5, tech-spec.md §8.6, ADR-131 §3) ═

function assertAmendmentStatus(a: AmendmentRecord, allowed: string[]): void {
  if (!allowed.includes(a.amendment.negotiation_status)) {
    throw new RealMockError(409, 'invalid_negotiation_transition', `Недопустимое действие для статуса допника ${a.amendment.negotiation_status}.`);
  }
}

const AMENDMENT_TOPICS_IN_CONTRACT_TIMELINE = new Set(['amendment.sent', 'amendment.rejected', 'amendment.withdrawn']);

function pushAmendmentEvent(a: AmendmentRecord, topic: string, payload: Record<string, unknown>, occurredAt = new Date().toISOString()): void {
  a.timeline.push({ event_id: nextId('te'), topic, occurred_at: occurredAt, actor: {}, subject: { type: 'amendment', id: a.amendment.id }, payload });
  // ADR-134: ключевые события допника видны и в хронике договора (свёрнутой группой).
  const record = registry.get(a.amendment.contract_id);
  if (record && AMENDMENT_TOPICS_IN_CONTRACT_TIMELINE.has(topic)) {
    pushNestedEvent(record, topic, { type: 'amendment', id: a.amendment.id, title: `Допсоглашение №${a.amendment.order}` }, null);
  }
}

/** `compute_amendment_deltas` — суммарные дельты по всем изменениям. */
function amendmentDeltas(a: AmendmentRecord): { amount_delta: RealAmendment['amount_delta']; days_delta: number } {
  let total: { amount: number; currency: string } | null = null;
  let days = 0;
  for (const ch of a.amendment.changes) {
    if (ch.amount_delta !== null && ch.amount_delta_currency !== null) {
      total = total
        ? { amount: total.amount + Number(ch.amount_delta), currency: total.currency }
        : { amount: Number(ch.amount_delta), currency: ch.amount_delta_currency };
    }
    days += ch.days_delta;
  }
  return { amount_delta: total ? { amount: total.amount.toFixed(2), currency: total.currency } : null, days_delta: days };
}

function toApiAmendment(a: AmendmentRecord): RealAmendment {
  return { ...a.amendment, frozen_version_id: a.frozenVersion?.id ?? null, ...amendmentDeltas(a) };
}

function findAmendment(amendmentId: string): { record: ContractRecord; a: AmendmentRecord } {
  const a = amendmentRegistry.get(amendmentId);
  if (!a) throw new RealMockError(404, 'not_found', 'Допсоглашение не найдено.');
  const record = registry.get(a.amendment.contract_id);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  return { record, a };
}

/** Зеркало `selectors.is_amendment_visible_to` (ADR-161 §3). */
function assertAmendmentVisible(a: AmendmentRecord, viewerUserId?: string): void {
  if (!viewerUserId) return;
  if (a.amendment.negotiation_status === 'draft' && a.amendment.created_by_id !== viewerUserId) {
    throw new RealMockError(404, 'not_found', 'Допсоглашение не найдено.');
  }
}

/** `_create_amendment_change` — дельты считает СЕРВЕР по текущему дереву,
 * не клиент. Материалы в этом моке не смоделированы (создание материалов не
 * подключено фронтом — отчёт Фазы 1), для них дельта — из payload как есть. */
function buildAmendmentChange(record: ContractRecord, type: RealAmendmentChangeType, target: string | null, payload: Record<string, unknown>): RealAmendmentChange {
  let amount_delta: string | null = null;
  let amount_delta_currency: string | null = null;
  let days_delta = 0;
  const setDelta = (amount: number, currency: string) => {
    amount_delta = amount.toFixed(2);
    amount_delta_currency = currency;
  };
  const milestoneTarget = () => {
    const m = record.milestones.find((x) => x.id === target);
    if (!m) throw new RealMockError(404, 'amendment_change_target_not_found', 'Этап не найден в договоре.');
    return m;
  };
  if (type === 'add_milestone') {
    if (typeof payload.amount === 'string' && typeof payload.currency === 'string') setDelta(Number(payload.amount), payload.currency);
  } else if (type === 'remove_milestone') {
    const m = milestoneTarget();
    if (!isLeaf(record, m.id)) throw new RealMockError(422, 'amendment_remove_target_not_leaf', 'Допник убирает только листья.');
    if (m.accepted_at) throw new RealMockError(422, 'amendment_targets_accepted', 'Этап уже принят — убрать допником нельзя.');
    if (m.amount !== null && m.currency) setDelta(-Number(m.amount), m.currency);
  } else if (type === 'modify_milestone') {
    const m = milestoneTarget();
    if (typeof payload.amount === 'string' && typeof payload.currency === 'string') {
      const next = Number(payload.amount);
      const delta = m.amount !== null ? next - Number(m.amount) : next;
      if (m.accepted_at && delta < 0) throw new RealMockError(422, 'amendment_targets_accepted', 'Этап уже принят — удешевить допником нельзя.');
      setDelta(delta, payload.currency);
    }
    if (typeof payload.deadline === 'string' && m.deadline) {
      days_delta = Math.round((Date.parse(payload.deadline) - Date.parse(m.deadline)) / 86_400_000);
    }
  } else if (type === 'add_material' || type === 'modify_material') {
    if (typeof payload.unit_price === 'string' && typeof payload.unit_price_currency === 'string' && typeof payload.quantity === 'string') {
      setDelta(Number(payload.unit_price) * Number(payload.quantity), payload.unit_price_currency);
    }
  }
  return { id: nextId('ac'), type, target, payload, amount_delta, amount_delta_currency, days_delta, created_at: new Date().toISOString() };
}

/** `GET /contracts/{id}/amendments` — по `order`. ADR-161 §3: ЧУЖИЕ
 * ЧЕРНОВИКИ скрыты — до `send` допник существует только для своего
 * инициатора (`selectors.list_amendments(viewer=...)` на бэке). */
export function listAmendments(contractId: string, viewerUserId?: string): RealAmendment[] {
  if (!registry.has(contractId)) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  return [...amendmentRegistry.values()]
    .filter((a) => a.amendment.contract_id === contractId)
    .filter((a) => !viewerUserId || a.amendment.negotiation_status !== 'draft' || a.amendment.created_by_id === viewerUserId)
    .sort((x, y) => x.amendment.order - y.amendment.order)
    .map(toApiAmendment);
}

/** `GET /amendments/{id}`. ADR-161 §3: чужой черновик — 404, не 403 (403
 * подтвердил бы, что заготовка заведена). */
export function getAmendment(amendmentId: string, viewerUserId?: string): RealAmendment {
  const { a } = findAmendment(amendmentId);
  assertAmendmentVisible(a, viewerUserId);
  return toApiAmendment(a);
}

/** `POST /contracts/{id}/amendments` — только к ПОДПИСАННОМУ договору
 * (`ContractNotSignedError` -> 409). */
export function createAmendment(contractId: string, input: RealAmendmentCreateInput, callingUserId: string): RealAmendment {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  if (record.contract.negotiation_status !== 'signed') {
    throw new RealMockError(409, 'contract_not_signed', 'Допсоглашение можно завести только к подписанному договору.');
  }
  const order = listAmendments(contractId).reduce((m, a) => Math.max(m, a.order), 0) + 1;
  const id = nextId('am');
  const a: AmendmentRecord = {
    amendment: {
      id,
      contract_id: contractId,
      order,
      reason: input.reason,
      custom_terms: input.custom_terms ?? '',
      negotiation_status: 'draft',
      created_by_id: callingUserId,
      created_at: new Date().toISOString(),
      changes: input.changes.map((c) => buildAmendmentChange(record, c.type, c.target ?? null, c.payload ?? {})),
    },
    frozenVersion: null,
    signatureRequests: [],
    signatures: [],
    timeline: [],
  };
  amendmentRegistry.set(id, a);
  pushAmendmentEvent(a, 'amendment.drafted', { contract_id: contractId, order, changes_count: a.amendment.changes.length });
  return toApiAmendment(a);
}

/** `create_discount_amendment` (ADR-131 §3): скидка по спору = допник с одним
 * MODIFY_MILESTONE, СРАЗУ на согласовании; анти-waiver-оговорка — в payload
 * (значит, в подписываемом снимке). Вызывается из `disputesDb.proposeDiscount`. */
export function createDiscountAmendment(
  contractId: string,
  input: { milestone_id: string; new_amount: string; currency: string; anti_waiver_note: string; reason: string },
  callingUserId: string,
): RealAmendment {
  const created = createAmendment(
    contractId,
    {
      reason: input.reason,
      changes: [{ type: 'modify_milestone', target: input.milestone_id, payload: { amount: input.new_amount, currency: input.currency, anti_waiver: input.anti_waiver_note } }],
    },
    callingUserId,
  );
  return sendAmendment(created.id);
}

/** Гейт правки/удаления ЧЕРНОВИКА (ADR-161 §2): сначала «чей», потом «в
 * каком состоянии» — чужой допник не должен даже подсказывать, отправлен он
 * уже или нет. */
function assertDraftOfInitiator(record: ContractRecord, a: AmendmentRecord, callingUserId: string): void {
  if (!isPartyUser(record, callingUserId)) throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора.');
  if (a.amendment.created_by_id !== callingUserId) {
    throw new RealMockError(403, 'not_initiator', 'Править допсоглашение может только его инициатор.');
  }
  if (a.amendment.negotiation_status !== 'draft') {
    throw new RealMockError(409, 'amendment_not_draft', 'Допсоглашение уже отправлено — править и удалять можно только черновик.');
  }
}

/** `PATCH /amendments/{id}` (ADR-161 §2) — `changes` заменяется ЦЕЛИКОМ,
 * дельты пересчитываются тем же `buildAmendmentChange`, что при создании. */
export function updateDraftAmendment(amendmentId: string, input: RealAmendmentCreateInput, callingUserId: string): RealAmendment {
  const { record, a } = findAmendment(amendmentId);
  assertAmendmentVisible(a, callingUserId);
  assertDraftOfInitiator(record, a, callingUserId);
  a.amendment.reason = input.reason;
  a.amendment.custom_terms = input.custom_terms ?? '';
  a.amendment.changes = input.changes.map((c) => buildAmendmentChange(record, c.type, c.target ?? null, c.payload ?? {}));
  return toApiAmendment(a);
}

/** `DELETE /amendments/{id}` -> 204 (ADR-161 §2) — инициатор выбрасывает СВОЙ
 * черновик; отправленный не удаляется. */
export function deleteDraftAmendment(amendmentId: string, callingUserId: string): void {
  const { record, a } = findAmendment(amendmentId);
  assertAmendmentVisible(a, callingUserId);
  assertDraftOfInitiator(record, a, callingUserId);
  amendmentRegistry.delete(amendmentId);
}

/** `POST /amendments/{id}/send` — `draft -> under_review`. */
export function sendAmendment(amendmentId: string): RealAmendment {
  const { a } = findAmendment(amendmentId);
  assertAmendmentStatus(a, ['draft']);
  a.amendment.negotiation_status = 'under_review';
  pushAmendmentEvent(a, 'amendment.sent', { contract_id: a.amendment.contract_id });
  return toApiAmendment(a);
}

/** `POST /amendments/{id}/freeze` — `under_review -> pending_signature`; снимок
 * допника — та же таблица версий договора. */
export function freezeAmendment(amendmentId: string): RealContractVersion {
  const { record, a } = findAmendment(amendmentId);
  assertAmendmentStatus(a, ['under_review']);
  const versionId = nextId('cv');
  const now = new Date().toISOString();
  const hash = versionId.padEnd(64, '0');
  const version: RealContractVersion = {
    id: versionId,
    contract_id: record.contract.id,
    snapshot: {
      amendment_id: a.amendment.id,
      contract_id: record.contract.id,
      order: a.amendment.order,
      reason: a.amendment.reason,
      custom_terms: a.amendment.custom_terms,
      changes: a.amendment.changes,
      ...amendmentDeltas(a),
    },
    integrity_hash: hash,
    hash_algorithm: 'sha256',
    frozen_at: now,
    trusted_timestamp_source: 'mock-tsa',
    trusted_timestamp_at: now,
    official_language: record.contract.language || 'ru',
    renders: {},
  };
  a.frozenVersion = version;
  a.amendment.negotiation_status = 'pending_signature';
  pushAmendmentEvent(a, 'amendment.frozen', { contract_id: record.contract.id, version_id: versionId, integrity_hash: hash }, now);
  return version;
}

/** `GET /amendments/{id}/signatories?side=` — подписанты стороны ДОГОВОРА. */
export function listAmendmentSignatories(amendmentId: string, side: string): RealSignatoryOption[] {
  const { record } = findAmendment(amendmentId);
  return listSignatories(record.contract.id, side);
}

/** `GET /amendments/{id}/signature-requests` — свежая первой (`-sent_at`). */
export function listAmendmentSignatureRequests(amendmentId: string): RealSignatureRequest[] {
  return findAmendment(amendmentId).a.signatureRequests;
}

/** `GET /amendments/{id}/timeline` — `subject.type = "amendment"`. */
export function listAmendmentTimeline(amendmentId: string): RealTimelineEvent[] {
  // Тот же сериализатор, что у хроники договора (`timeline_entries` — общий
  // вход для лент сиблинг-сущностей, ADR-134): `title`/`detail` с «бэка».
  return findAmendment(amendmentId).a.timeline.map(toApiTimelineEvent);
}

/** `POST /amendments/{id}/signature-requests` — `route_amendment_signatory`. */
export function createAmendmentSignatureRequest(amendmentId: string, input: RealSignatureRequestCreateInput): RealSignatureRequest {
  const { record, a } = findAmendment(amendmentId);
  assertAmendmentStatus(a, ['pending_signature', 'awaiting_signatures']);
  if (!a.frozenVersion || a.frozenVersion.id !== input.version_id) {
    throw new RealMockError(409, 'version_stale', 'Версия допсоглашения устарела.');
  }
  if (a.signatureRequests.some((s) => s.side === input.side && s.status === 'pending')) {
    throw new RealMockError(409, 'signature_request_already_pending', 'У этой стороны уже есть незакрытый запрос подписи.');
  }
  const party = record.contract.parties.find((p) => p.role === input.side);
  const routedBy = party ? (OWNER_USER_ID[party.profile_id] ?? input.signatory_user_id) : input.signatory_user_id;
  const sigReq: RealSignatureRequest = {
    id: nextId('sr'),
    contract_id: record.contract.id,
    amendment_id: a.amendment.id,
    version_id: input.version_id,
    side: input.side,
    routed_by_id: routedBy,
    signatory_id: input.signatory_user_id,
    status: 'pending',
    sent_at: new Date().toISOString(),
    expires_at: null,
    comment: input.comment ?? '',
    locale: '',
  };
  a.signatureRequests = [sigReq, ...a.signatureRequests];
  a.amendment.negotiation_status = 'awaiting_signatures';
  pushAmendmentEvent(a, 'amendment.signature_requested', { signature_request_id: sigReq.id, side: input.side, signatory_user_id: input.signatory_user_id }, sigReq.sent_at);
  return sigReq;
}

/** `sign_amendment`: подпись на `integrity_hash` ЗАМОРОЖЕННОЙ версии допника;
 * вторая подпись — одной операцией `signed` + `apply_amendment` (дерево
 * этапов меняется здесь же) + `contract.amended` в хронику ДОГОВОРА. */
function signAmendmentRequest(record: ContractRecord, a: AmendmentRecord, sigReq: RealSignatureRequest, input: RealSignInput): RealSignature {
  if (!a.frozenVersion || a.frozenVersion.integrity_hash !== input.version_hash) {
    throw new RealMockError(409, 'version_stale', 'Версия допсоглашения устарела.');
  }
  assertAmendmentStatus(a, ['awaiting_signatures']);
  sigReq.status = 'signed';
  const party = record.contract.parties.find((p) => p.role === sigReq.side);
  const signature: RealSignature = {
    id: nextId('sig'),
    contract_id: record.contract.id,
    amendment_id: a.amendment.id,
    version_hash: input.version_hash,
    side: sigReq.side,
    signatory_id: sigReq.signatory_id,
    signed_at: new Date().toISOString(),
    signature_basis: party?.acting_as === 'business' ? 'business' : 'person',
  };
  sigReq.signed_at = signature.signed_at;
  a.signatures.push(signature);
  const sides = new Set(record.contract.parties.map((p) => p.role));
  const signedSides = new Set(a.signatures.map((s) => s.side));
  if ([...sides].every((s) => signedSides.has(s))) {
    a.amendment.negotiation_status = 'signed';
    applyAmendment(record, a);
    record.timeline.push({ event_id: nextId('te'), topic: 'contract.amended', occurred_at: signature.signed_at, actor: {}, subject: { type: 'contract', id: record.contract.id }, payload: { amendment_id: a.amendment.id, integrity_hash: input.version_hash } });
    emitAmendmentEvent({ topic: 'amendment.signed_final', amendmentId: a.amendment.id, contractId: record.contract.id, actorUserId: sigReq.signatory_id });
  } else {
    pushAmendmentEvent(a, 'amendment.signed', { side: sigReq.side, integrity_hash: input.version_hash }, signature.signed_at);
  }
  return signature;
}

/**
 * Шина «событий допника» для других мок-сторов — зеркало подписчиков outbox
 * (`apps.disputes.handlers`: подписанный допник-скидка закрывает спор
 * `discount_accepted`, отклонённый/отозванный — возвращает спор в `open`).
 * `disputesDb` подписывается сам: этот стор про `disputesDb` не знает
 * (граница «contracts не импортирует disputes» — как import-linter на бэке).
 */
export interface AmendmentMockEvent {
  topic: 'amendment.signed_final' | 'amendment.rejected' | 'amendment.withdrawn';
  amendmentId: string;
  contractId: string;
  actorUserId: string;
  reason?: string;
}
const amendmentSubscribers: ((event: AmendmentMockEvent) => void)[] = [];
export function subscribeAmendmentEvents(subscriber: (event: AmendmentMockEvent) => void): void {
  amendmentSubscribers.push(subscriber);
}
function emitAmendmentEvent(event: AmendmentMockEvent): void {
  for (const subscriber of amendmentSubscribers) subscriber(event);
}

/** Пользователь — сторона договора? (`services.is_party`: владельцы профилей
 * сторон; в моке — карта `OWNER_USER_ID`). */
function isPartyUser(record: ContractRecord, userId: string): boolean {
  return record.contract.parties.some((p) => OWNER_USER_ID[p.profile_id] === userId);
}

/** Аннулирование раунда подписи допника (общая `NEGOTIATION_FSM`:
 * `withdraw`/`reject` из замороженных состояний «с аннулированием раунда»):
 * pending-заявки -> `declined_for_revision`, подписи допника удалены,
 * `frozen_version_id: null`. Возвращает id аннулированного — уходит в payload
 * события `amendment.withdrawn`/`amendment.rejected`. */
function annulAmendmentRound(a: AmendmentRecord): { annulled_signature_request_ids: string[]; annulled_signature_ids: string[] } {
  const annulledRequests = a.signatureRequests.filter((r) => r.status === 'pending').map((r) => r.id);
  const annulledSignatures = a.signatures.map((s) => s.id);
  a.signatureRequests = a.signatureRequests.map((r) => (r.status === 'pending' ? { ...r, status: 'declined_for_revision' } : r));
  a.signatures = [];
  a.frozenVersion = null;
  return { annulled_signature_request_ids: annulledRequests, annulled_signature_ids: annulledSignatures };
}

const AMENDMENT_CLOSABLE: NegotiationStatus[] = ['under_review', 'pending_signature', 'awaiting_signatures'];

/** `POST /amendments/{id}/withdraw` — ТОЛЬКО инициатор (`created_by_id`),
 * иначе 403 `not_initiator` (тот же код, что у `withdraw_negotiation`
 * договора); `-> withdrawn_by_initiator`, событие `amendment.withdrawn`. */
export function withdrawAmendment(amendmentId: string, input: RealAmendmentCloseInput, callingUserId: string): RealAmendment {
  const { record, a } = findAmendment(amendmentId);
  if (!isPartyUser(record, callingUserId)) throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора.');
  if (a.amendment.created_by_id !== callingUserId) {
    throw new RealMockError(403, 'not_initiator', 'Отозвать допсоглашение может только его инициатор.');
  }
  assertAmendmentStatus(a, AMENDMENT_CLOSABLE);
  const annulled = annulAmendmentRound(a);
  a.amendment.negotiation_status = 'withdrawn_by_initiator';
  const reason = input.reason?.trim() ?? '';
  pushAmendmentEvent(a, 'amendment.withdrawn', { contract_id: record.contract.id, order: a.amendment.order, reason, ...annulled });
  emitAmendmentEvent({ topic: 'amendment.withdrawn', amendmentId, contractId: record.contract.id, actorUserId: callingUserId, reason });
  return toApiAmendment(a);
}

/** `POST /amendments/{id}/reject` — ВТОРАЯ сторона (не инициатор), иначе
 * 403 `not_counterparty`; `-> rejected_by_counterparty`, событие
 * `amendment.rejected`. */
export function rejectAmendment(amendmentId: string, input: RealAmendmentCloseInput, callingUserId: string): RealAmendment {
  const { record, a } = findAmendment(amendmentId);
  if (!isPartyUser(record, callingUserId)) throw new RealMockError(403, 'permission_denied', 'Вы не сторона этого договора.');
  if (a.amendment.created_by_id === callingUserId) {
    throw new RealMockError(403, 'not_counterparty', 'Отклонить допсоглашение может только вторая сторона; инициатор — отзывает.');
  }
  assertAmendmentStatus(a, AMENDMENT_CLOSABLE);
  const annulled = annulAmendmentRound(a);
  a.amendment.negotiation_status = 'rejected_by_counterparty';
  const reason = input.reason?.trim() ?? '';
  pushAmendmentEvent(a, 'amendment.rejected', { contract_id: record.contract.id, order: a.amendment.order, reason, ...annulled });
  emitAmendmentEvent({ topic: 'amendment.rejected', amendmentId, contractId: record.contract.id, actorUserId: callingUserId, reason });
  return toApiAmendment(a);
}

/** `apply_amendment` — изменения к дереву (материалы в моке не смоделированы,
 * `custom_term` дерева не касается). */
function applyAmendment(record: ContractRecord, a: AmendmentRecord): void {
  for (const ch of a.amendment.changes) {
    const p = ch.payload;
    if (ch.type === 'add_milestone') {
      record.milestones.push(
        seedMilestone({
          id: nextId('ms'),
          title: typeof p.title === 'string' ? p.title : '',
          parent_id: typeof p.parent_id === 'string' ? p.parent_id : null,
          order: record.milestones.length,
          amount: typeof p.amount === 'string' ? p.amount : null,
          currency: typeof p.currency === 'string' ? p.currency : null,
          deadline: typeof p.deadline === 'string' ? p.deadline : null,
          status: 'pending',
        }),
      );
    } else if (ch.type === 'modify_milestone') {
      const m = record.milestones.find((x) => x.id === ch.target);
      if (!m) continue;
      if (typeof p.title === 'string') m.title = p.title;
      if (typeof p.amount === 'string') m.amount = Number(p.amount).toFixed(2);
      if (typeof p.currency === 'string') m.currency = p.currency;
      if (typeof p.deadline === 'string') m.deadline = p.deadline;
    } else if (ch.type === 'remove_milestone') {
      record.milestones = record.milestones.filter((x) => x.id !== ch.target);
    }
  }
}

/** `GET /contracts/{id}/effective-terms` — `services.effective_terms`. */
export function effectiveTerms(contractId: string): RealEffectiveTerms {
  const record = registry.get(contractId);
  if (!record) throw new RealMockError(404, 'not_found', 'Договор не найден.');
  const base = (record.frozenVersion?.snapshot ?? {}) as Record<string, unknown>;
  const amendments = listAmendments(contractId)
    .filter((a) => a.negotiation_status === 'signed')
    .map((a) => ({ order: a.order, reason: a.reason, custom_terms: a.custom_terms, amount_delta: a.amount_delta, days_delta: a.days_delta }));
  return { ...base, amendments, total_amount: totalLeafAmount(record) };
}

/** Сиды допников — на rc-progress-1 (Годвин — исполнитель): подписанный
 * (order 1, прочее условие) и скидка по разногласию `dsp-discount-1`
 * (`am-seed-1`, order 2, ADR-131 §3 — на согласовании, предложил заказчик
 * `u-2001`; плитка 45000 -> 40000 RUB). */
function seedAmendments(): void {
  amendmentRegistry.set('am-seed-signed-1', {
    amendment: {
      id: 'am-seed-signed-1',
      contract_id: 'rc-progress-1',
      order: 1,
      reason: 'Уточнение режима работ по просьбе соседей',
      custom_terms: 'Шумные работы — только с 10:00 до 18:00 по будням.',
      negotiation_status: 'signed',
      created_by_id: 'u-2001',
      created_at: '2026-08-11T09:00:00Z',
      changes: [
        { id: 'ac-seed-1', type: 'custom_term', target: null, payload: { text: 'Шумные работы — только с 10:00 до 18:00 по будням.' }, amount_delta: null, amount_delta_currency: null, days_delta: 0, created_at: '2026-08-11T09:00:00Z' },
      ],
    },
    frozenVersion: mockVersion('cv-am-1', 'rc-progress-1', '2026-08-11T10:00:00Z'),
    signatureRequests: [
      { id: 'sr-am-1-contractor', contract_id: 'rc-progress-1', amendment_id: 'am-seed-signed-1', version_id: 'cv-am-1', side: 'contractor', routed_by_id: 'u-1001', signatory_id: 'u-1001', status: 'signed', sent_at: '2026-08-11T11:00:00Z', expires_at: null, comment: '', locale: '', signed_at: '2026-08-11T11:20:00Z' },
      { id: 'sr-am-1-customer', contract_id: 'rc-progress-1', amendment_id: 'am-seed-signed-1', version_id: 'cv-am-1', side: 'customer', routed_by_id: 'u-2001', signatory_id: 'u-2001', status: 'signed', sent_at: '2026-08-11T10:30:00Z', expires_at: null, comment: '', locale: '', signed_at: '2026-08-11T10:40:00Z' },
    ],
    signatures: [
      { id: 'sig-am-1-customer', contract_id: 'rc-progress-1', amendment_id: 'am-seed-signed-1', version_hash: 'cv-am-1'.padEnd(64, '0'), side: 'customer', signatory_id: 'u-2001', signed_at: '2026-08-11T10:40:00Z', signature_basis: 'person' },
      { id: 'sig-am-1-contractor', contract_id: 'rc-progress-1', amendment_id: 'am-seed-signed-1', version_hash: 'cv-am-1'.padEnd(64, '0'), side: 'contractor', signatory_id: 'u-1001', signed_at: '2026-08-11T11:20:00Z', signature_basis: 'person' },
    ],
    timeline: [
      { event_id: 'te-am-1', topic: 'amendment.drafted', occurred_at: '2026-08-11T09:00:00Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-signed-1' }, payload: { contract_id: 'rc-progress-1', order: 1, changes_count: 1 } },
      { event_id: 'te-am-2', topic: 'amendment.sent', occurred_at: '2026-08-11T09:05:00Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-signed-1' }, payload: { contract_id: 'rc-progress-1' } },
      { event_id: 'te-am-3', topic: 'amendment.frozen', occurred_at: '2026-08-11T10:00:00Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-signed-1' }, payload: { contract_id: 'rc-progress-1', version_id: 'cv-am-1', integrity_hash: 'cv-am-1'.padEnd(64, '0') } },
      { event_id: 'te-am-4', topic: 'amendment.signed', occurred_at: '2026-08-11T10:40:00Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-signed-1' }, payload: { side: 'customer' } },
    ],
  });
  amendmentRegistry.set('am-seed-1', {
    amendment: {
      id: 'am-seed-1',
      contract_id: 'rc-progress-1',
      order: 2,
      reason: 'Скидка по разногласию: полоса затирки у окна',
      custom_terms: '',
      negotiation_status: 'under_review',
      created_by_id: 'u-2001',
      created_at: '2026-08-24T12:00:00Z',
      changes: [
        {
          id: 'ac-seed-2',
          type: 'modify_milestone',
          target: 'ms-3',
          payload: { amount: '40000.00', currency: 'RUB', anti_waiver: 'Скидка закрывает только полосу затирки у окна и не снимает прочих требований.' },
          amount_delta: '-5000.00',
          amount_delta_currency: 'RUB',
          days_delta: 0,
          created_at: '2026-08-24T12:00:00Z',
        },
      ],
    },
    frozenVersion: null,
    signatureRequests: [],
    signatures: [],
    timeline: [
      { event_id: 'te-am-5', topic: 'amendment.drafted', occurred_at: '2026-08-24T12:00:00Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-1' }, payload: { contract_id: 'rc-progress-1', order: 2, changes_count: 1 } },
      { event_id: 'te-am-6', topic: 'amendment.sent', occurred_at: '2026-08-24T12:00:01Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-1' }, payload: { contract_id: 'rc-progress-1' } },
    ],
  });
  // ADR-161: ЧЕРНОВИК, заведённый САМИМ смотрящим (`u-1001`, Годвин) — иначе
  // правку и удаление черновика проверить нечем: `getMe()` в моках всегда он,
  // а оба соседних сида завёл контрагент `u-2001`. Второй стороне этот
  // черновик не виден (`listAmendments` фильтрует по `viewerUserId`).
  amendmentRegistry.set('am-seed-draft-1', {
    amendment: {
      id: 'am-seed-draft-1',
      contract_id: 'rc-progress-1',
      order: 3,
      reason: 'Черновик: перенос срока по второму этапу',
      custom_terms: '',
      negotiation_status: 'draft',
      created_by_id: 'u-1001',
      created_at: '2026-08-26T08:00:00Z',
      changes: [],
    },
    frozenVersion: null,
    signatureRequests: [],
    signatures: [],
    timeline: [
      { event_id: 'te-am-7', topic: 'amendment.drafted', occurred_at: '2026-08-26T08:00:00Z', actor: {}, subject: { type: 'amendment', id: 'am-seed-draft-1' }, payload: { contract_id: 'rc-progress-1', order: 3, changes_count: 0 } },
    ],
  });
}
