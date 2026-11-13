/**
 * Мок-FSM договорного контура (Ф2) — ЗЕРКАЛО бэкенда, не заглушка.
 * In-memory стор с seed-данными; реализует переходы согласования §6.1,
 * валидации заморозки, timeline. Недопустимый переход/
 * валидация → MockError со статусом и доменным `code` (как сделал бы Django).
 *
 * В Ф6 заменяется реальным API — это замена транспорта, не логики UI.
 */
import {
  previewSegment,
  canTransition,
  type ContractAttention,
  type ContractDetail,
  type ContractKind,
  type ContractMaterial,
  type ContractSegment,
  type ContractTerms,
  type CurrencyPolicy,
  type MilestoneNode,
  type StageStatus,
  type NegotiationStatus,
  type PartyDetails,
  type PaymentMethodOption,
  type PaymentPolicy,
  type ProtectionLevel,
  type RevisionAuthorRole,
  type RevisionProposal,
  type RevisionVariant,
  type PreapprovedAlternative,
  type TimelineEvent,
  type TimelineKind,
  type TransferFeePolicy,
  type MoneyLike,
  type ProfileKind,
  type ContractStatus,
  type ContractSummary,
  type ContractRender,
} from '@porukam/core';
import { handleDirectory } from './catalog';

export class MockError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) {
    super(detail);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let seq = 1000;
const nid = (p: string) => `${p}-${++seq}`;

const RUB = (a: string): MoneyLike => ({ amount: a, currency: 'RUB' });
const now = () => new Date().toISOString();

/** Псевдо-sha256 (детерминированный, не крипто) для integrity_hash витрины. */
function fakeHash(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0');
  return (hex.repeat(8)).slice(0, 64);
}

// ── Профили пользователя (совпадают с mockUser) ──
// export — переиспользуются проекцией списка сделок (DEV-13, contractsListDb.ts) для «my_role».
export const ME_PERSON = { profile_id: 'pf-person-1', display_name: 'Годвин', handle: '@godwin', kind: 'person' as ProfileKind };
export const ME_BIZ = { profile_id: 'pf-biz-1', display_name: 'ИП Годвин', handle: '@teplo_remont', kind: 'business' as ProfileKind };

/** ADR-050 «как в прошлый раз» (DEV-13 §6) — клон дерева этапов со свежими id, без статуса
 * исполнения (черновик ещё не подписан). */
function cloneMilestoneTree(nodes: MilestoneNode[]): MilestoneNode[] {
  const idMap = new Map<string, string>();
  for (const n of nodes) idMap.set(n.id, nid('ms'));
  return nodes.map((n) => ({
    ...n,
    id: idMap.get(n.id)!,
    parent_id: n.parent_id ? (idMap.get(n.parent_id) ?? null) : null,
    checklist_items: n.checklist_items.map((ci) => ({ ...ci, id: nid('cl') })),
    materials: n.materials.map((m) => ({ ...m, id: nid('mat') })),
    status: undefined,
    meta: undefined,
  }));
}

function leafSum(milestones: MilestoneNode[]): MoneyLike {
  let sum = 0;
  let currency = 'RUB';
  for (const m of milestones) {
    if (m.kind === 'leaf' && m.amount) {
      sum += Number(m.amount.amount);
      currency = m.amount.currency;
    }
  }
  return { amount: (Math.round(sum * 100) / 100).toFixed(2), currency };
}

/** Пересчитывает сумму листьев и денежную политику (комиссия зависит от total) — вызывать после правки дерева/сумм. */
/**
 * DEV-09 §6/§7 — продажа/аренда/займ (без графика) не имеют дерева этапов: сумма договора
 * берётся из соответствующего поля `form_data` (цена/плата за период/сумма займа), а не из
 * листьев. Услуга и займ-с-графиком считаются как раньше — по сумме листьев.
 */
function totalFromFormData(c: ContractDetail): MoneyLike | null {
  const fd = c.form_data ?? {};
  const currency = c.total.currency;
  const field = c.contract_kind === 'sale' ? fd.price : c.contract_kind === 'rent_items' || c.contract_kind === 'rent_home' ? fd.rent_amount : c.contract_kind === 'loan' ? fd.amount : undefined;
  const n = Number(field);
  return Number.isFinite(n) ? { amount: n.toFixed(2), currency } : null;
}

function syncTotals(c: ContractDetail): void {
  const leaves = leafSum(c.milestones);
  c.total = leaves.amount !== '0.00' ? leaves : (totalFromFormData(c) ?? leaves);
  c.payment_policy = recomputePaymentPolicy(c);
}

/** Определяем «бизнес» по своему бизнес-профилю или справочнику хендлов. */
function kindOfHandle(handle: string | undefined): ProfileKind {
  if (!handle) return 'person';
  if (handle === ME_BIZ.handle) return 'business';
  const dir = handleDirectory.find((h) => h.handle === handle);
  return dir?.kind ?? 'person';
}

function recomputeSegment(c: ContractDetail): ContractSegment {
  const customer = c.parties.find((p) => p.role === 'customer');
  const contractor = c.parties.find((p) => p.role === 'contractor');
  return previewSegment({
    customerKind: kindOfHandle(customer?.handle),
    contractorKind: kindOfHandle(contractor?.handle),
    isPaid: c.protection_level === 'direct_platform',
  });
}

/**
 * Денежная политика по юрисдикции (DEV-05-PATCH, ADR-032) — мок играет роль
 * бэкенда с JurisdictionConfig: только ЗДЕСЬ разрешены литералы валют/тарифов.
 * Ядро (packages/core) и UI-компоненты знают лишь структуру `PaymentPolicy`.
 */
type JurisdictionCode = 'RU' | 'OTHER' | 'NO_PROVIDER';

/** [Ф-решение] DEV-05-PATCH: id договоров демо-варианта «другая юрисдикция» (§5). */
const OTHER_JURISDICTION_IDS = new Set(['c-3005']);
/** [Ф-решение] DEV-07 §4 (e): демо без подключённого онлайн-провайдера — только наличные, без переключателя. */
const NO_PROVIDER_JURISDICTION_IDS = new Set(['c-5005']);

function jurisdictionOf(id: string): JurisdictionCode {
  if (NO_PROVIDER_JURISDICTION_IDS.has(id)) return 'NO_PROVIDER';
  return OTHER_JURISDICTION_IDS.has(id) ? 'OTHER' : 'RU';
}

const CASH_METHOD: PaymentMethodOption = { kind: 'cash', labelKey: 'payment.methodCash' };
const SBP_METHOD: PaymentMethodOption = { kind: 'sbp', labelKey: 'payment.methodSbp' };

const JURISDICTION_TRANSFER: Record<
  JurisdictionCode,
  { currency: CurrencyPolicy; transferFee: TransferFeePolicy; methods: PaymentMethodOption[] }
> = {
  RU: {
    currency: { code: 'RUB', symbol: '₽', decimals: 2 },
    transferFee: {
      platformTakesCommission: false,
      operatorTariff: 'none',
      labelKey: 'signing.paymentsFreeTitle',
      noteKey: 'signing.paymentsFreeNote',
    },
    methods: [CASH_METHOD, SBP_METHOD],
  },
  OTHER: {
    currency: { code: 'USD', symbol: '$', decimals: 2 },
    transferFee: {
      platformTakesCommission: true,
      operatorTariff: 'payer',
      labelKey: 'signing.paymentsPaidTitle',
      noteKey: 'signing.paymentsPaidNote',
    },
    methods: [CASH_METHOD, SBP_METHOD],
  },
  // Юрисдикция без подключённого онлайн-провайдера (DEV-07 §4/§8) — только наличные,
  // без переключателя способа (PaymentMethodPicker сам это решает по длине methods).
  NO_PROVIDER: {
    currency: { code: 'RUB', symbol: '₽', decimals: 2 },
    transferFee: {
      platformTakesCommission: false,
      operatorTariff: 'none',
      labelKey: 'signing.paymentsFreeTitle',
      noteKey: 'signing.paymentsFreeNote',
    },
    methods: [CASH_METHOD],
  },
};

/**
 * Финмодель v2 (01.08, док 09 v2/28/29): комиссия за заключение договора
 * отменена ПОЛНОСТЬЮ — `contractFee.applies` теперь всегда false, для любого
 * сегмента. Ядро (договор/подпись/доказательства/репутация) бесплатно и
 * безлимитно; монетизация — подписка, отдельная волна (сейчас не проектируем,
 * см. docs/tasks/DEV-05-patch_jurisdiction-money.md). labelKey/noteKey несут
 * копирайт «заключение — бесплатно», не описание комиссии.
 */
function buildPaymentPolicy(_total: MoneyLike, _segment: ContractSegment, jurisdiction: JurisdictionCode): PaymentPolicy {
  const { currency, transferFee, methods } = JURISDICTION_TRANSFER[jurisdiction];
  return {
    currency,
    contractFee: {
      applies: false,
      whoPays: null,
      amount: undefined,
      percent: undefined,
      nonRefundable: false,
      labelKey: 'signing.freeCoreTitle',
      noteKey: 'signing.freeCoreNote',
    },
    transferFee,
    methods,
  };
}

function recomputePaymentPolicy(c: ContractDetail): PaymentPolicy {
  return buildPaymentPolicy(c.total, c.segment, jurisdictionOf(c.id));
}

/**
 * DEV-09 §2/§6 — валюта договора выбирается пользователем в шаге «Суть» (`CurrencyField`),
 * это НЕ то же самое, что денежная политика юрисдикции (символ/decimals для отображения
 * платёжных способов) — но чтобы суммы на превью не расходились по символу, синхронизируем
 * символ/decimals политики с выбранной валютой договора (мок; юрисдикция всё ещё RU/методы
 * не меняются).
 */
const CURRENCY_SYMBOL: Record<string, { symbol: string; decimals: number }> = {
  RUB: { symbol: '₽', decimals: 2 },
  USD: { symbol: '$', decimals: 2 },
  EUR: { symbol: '€', decimals: 2 },
};
function currencyPolicyFor(code: string): CurrencyPolicy {
  const known = CURRENCY_SYMBOL[code];
  return { code, symbol: known?.symbol ?? code, decimals: known?.decimals ?? 2 };
}

/** Условия по умолчанию (DEV-09 §2, ⭐ «примеры/предзаполнение — везде»). */
const DEFAULT_TERMS: ContractTerms = {
  warranty_months: 12,
  acceptance_window_days: 3,
  subcontract: 'with_consent',
  premises_access: false,
  portfolio_consent: false,
};

function pushEvent(c: ContractDetail, kind: TimelineKind, actor: RevisionAuthorRole | 'system', text: string): void {
  const e: TimelineEvent = { id: nid('ev'), at: now(), kind, actor_role: actor, text };
  c.timeline.push(e);
  c.updated_at = e.at;
}

// ─────────────────────────────────────────────────────────────
//  Стор
// ─────────────────────────────────────────────────────────────
let contracts: ContractDetail[] = [];

function seedTree(rootTitle: string, leaves: { title: string; amount: string }[]): MilestoneNode[] {
  const rootId = nid('ms');
  const nodes: MilestoneNode[] = [
    { id: rootId, parent_id: null, title: rootTitle, kind: 'branch', amount: null, depth: 0, checklist_items: [], materials: [] },
  ];
  for (const l of leaves) {
    nodes.push({
      id: nid('ms'),
      parent_id: rootId,
      title: l.title,
      kind: 'leaf',
      amount: RUB(l.amount),
      depth: 1,
      checklist_items: [{ id: nid('cl'), text: `Критерий приёмки: ${l.title.toLowerCase()} выполнено`, required_evidence: true }],
      materials: [],
    });
  }
  return nodes;
}

/**
 * Язык договора (DEV-16b, Л.1) — мок зеркалит будущий бэк: официальный текст всегда
 * `en` (мастер не спрашивает язык, ГВ.5/Л.1 §0.1), а `viewer_render` подбирается НА
 * ЗАПРОС по `Accept-Language` (не хранится статично в версии) — `versionRenders`
 * хранит все доступные варианты рендера по версии, `resolveViewerFields` в
 * contractHandlers.ts выбирает нужный на каждый ответ.
 *
 * Реальных переводов у мока два: `en` (официальный, kind:'human') и `ru` (kind:'machine',
 * авто-перевод) — любой другой язык интерфейса (see `LanguageSwitcher`, DEV-16a) честно
 * не находит рендера → фронт показывает official + подсказку «перевод пока недоступен»
 * (не блокер, ровно то состояние и тестируем).
 */
export const versionRenders = new Map<string, Record<string, ContractRender>>();

function buildOfficialRender(c: Pick<ContractDetail, 'title' | 'total' | 'sphere'>): string {
  return `This is the official version of the agreement "${c.title}" (${c.sphere}), total ${c.total.amount} ${c.total.currency}. It governs the relationship between the parties as recorded in this frozen version.`;
}

function buildRuRender(c: Pick<ContractDetail, 'title' | 'total' | 'sphere'>): string {
  return `Это официальная версия договора «${c.title}» (${c.sphere}) на сумму ${c.total.amount} ${c.total.currency}. Он определяет отношения сторон в зафиксированном виде.`;
}

/** Регистрирует доступные рендеры версии (en + ru) — вызывается вместе с созданием ContractVersion. */
function registerRenders(versionId: string, c: Pick<ContractDetail, 'title' | 'total' | 'sphere'>): void {
  versionRenders.set(versionId, {
    en: { lang: 'en', kind: 'human', body: buildOfficialRender(c) },
    ru: { lang: 'ru', kind: 'machine', body: buildRuRender(c) },
  });
}

/** `Accept-Language: ru-RU,ru;q=0.9` → `ru` — первый язык, без региона/весов. */
export function primaryLanguage(acceptLanguage: string | null): string {
  const first = acceptLanguage?.split(',')[0]?.trim().split(';')[0]?.trim() ?? 'en';
  return first.split('-')[0]?.toLowerCase() || 'en';
}

/**
 * Пересчитывает `is_cross_language`/`viewer_render` НА ЗАПРОС по языку смотрящего
 * (DEV-16b) — не хранится статично в версии, ровно как это сделал бы реальный бэк
 * (Accept-Language решает, не создатель договора). Официальный язык совпадает с языком
 * смотрящего → чистый экран (is_cross_language: false, viewer_render не нужен).
 */
export function resolveViewerFields(
  versionId: string,
  officialLanguage: string,
  viewerLang: string,
): { is_cross_language: boolean; viewer_render?: ContractRender } {
  if (viewerLang === officialLanguage) return { is_cross_language: false };
  const available = versionRenders.get(versionId);
  return { is_cross_language: true, viewer_render: available?.[viewerLang] };
}

/** Замороженная версия для seed-договоров DEV-05 (§5 варианты a/b) — минуя freeze(), напрямую. */
function makeVersion(c: Pick<ContractDetail, 'title' | 'total' | 'milestones' | 'parties' | 'sphere' | 'protection_level'>) {
  const snapshotJson = JSON.stringify({ title: c.title, total: c.total, milestones: c.milestones, parties: c.parties });
  const t = now();
  const id = nid('ver');
  registerRenders(id, c);
  return {
    id,
    integrity_hash: fakeHash(snapshotJson),
    tsa_time: t,
    ai_summary: buildAiSummary(c as ContractDetail),
    ai_summary_items: buildAiSummaryItems(c as ContractDetail),
    snapshot_total: c.total,
    created_at: t,
    official_language: 'en',
    is_cross_language: false, // плейсхолдер — пересчитывается на запрос (см. выше)
    official_render: { lang: 'en', kind: 'human', body: buildOfficialRender(c) } satisfies ContractRender,
  };
}

function makeSeed(): ContractDetail[] {
  const t = now();
  const free: ContractDetail = {
    id: 'c-3001',
    title: 'Сборка шкафа-купе',
    body_kind: 'template',
    status: 'draft',
    segment: 'free_c2c',
    sphere: 'Сборка мебели',
    contract_type: 'furniture_assembly',
    tax_note: null,
    protection_level: 'none',
    parties: [
      { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
      { profile_id: 'pf-irina', display_name: 'Ирина Соколова', handle: '@irina_s', role: 'contractor' },
    ],
    initiator_role: 'customer',
    total: RUB('4000.00'),
    milestones: seedTree('Сборка и навеска', [
      { title: 'Сборка каркаса', amount: '2500.00' },
      { title: 'Навеска дверей и полок', amount: '1500.00' },
    ]),
    revisions: [],
    preapproved_alternatives: [
      {
        id: nid('pa'),
        item_ref: 'term:deadline',
        item_label: 'Срок',
        before: '5 дней',
        after: '7 дней',
        variants: [{ id: nid('var'), value: '7 дней' }],
      },
    ],
    version: null,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(RUB('4000.00'), 'free_c2c', 'RU'),
    ai_summary_shown: false,
    payout_account_id: null,
    timeline: [{ id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' }],
    created_at: t,
    updated_at: t,
  };

  const paid: ContractDetail = {
    id: 'c-3002',
    title: 'Ремонт кухни «под ключ»',
    body_kind: 'template',
    status: 'draft',
    segment: 'paid_business',
    sphere: 'Ремонт',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: [
      { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
      {
        profile_id: 'pf-master',
        display_name: 'Мастер Ремонт',
        handle: '@masterremont',
        role: 'contractor',
        signer_note: 'Подписывает Дмитрий Мастеров, ИП «Мастер Ремонт» — по праву единоличного исполнительного органа',
      },
    ],
    initiator_role: 'customer',
    total: RUB('120000.00'),
    milestones: seedTree('Ремонт кухни', [
      { title: 'Демонтаж', amount: '20000.00' },
      { title: 'Черновые работы', amount: '50000.00' },
      { title: 'Чистовая отделка', amount: '50000.00' },
    ]),
    revisions: [],
    preapproved_alternatives: [],
    version: null,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(RUB('120000.00'), 'paid_business', 'RU'),
    ai_summary_shown: false,
    payout_account_id: null,
    timeline: [{ id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' }],
    created_at: t,
    updated_at: t,
  };

  // ── DEV-05 · seed-варианты для экрана подписания (§5) ──
  const signingCustomerBase: Pick<ContractDetail, 'title' | 'sphere' | 'protection_level'> = {
    title: 'Поклейка обоев, комната 2',
    sphere: 'Ремонт',
    protection_level: 'none',
  };
  const signingFreeMilestones = seedTree('Поклейка обоев', [{ title: 'Поклейка обоев', amount: '14000.00' }]);
  const signingFreeParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-grom', display_name: 'Николай Гром', handle: '@grom_master', role: 'contractor' },
  ];
  // (a) C2C — заморожено, ждёт подписи, обе стороны без подписи (fee.applies: false).
  const signingFree: ContractDetail = {
    id: 'c-3003',
    ...signingCustomerBase,
    body_kind: 'template',
    status: 'awaiting_signatures',
    segment: 'free_c2c',
    contract_type: 'repair_works',
    tax_note: null,
    parties: signingFreeParties,
    initiator_role: 'customer',
    total: RUB('14000.00'),
    milestones: signingFreeMilestones,
    revisions: [],
    preapproved_alternatives: [],
    version: makeVersion({
      title: 'Поклейка обоев, комната 2',
      total: RUB('14000.00'),
      milestones: signingFreeMilestones,
      parties: signingFreeParties,
      sphere: 'Ремонт',
      protection_level: 'none',
    }),
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(RUB('14000.00'), 'free_c2c', 'RU'),
    ai_summary_shown: true,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'signature.requested', actor_role: 'system', text: 'Запрошены подписи сторон' },
    ],
    created_at: t,
    updated_at: t,
  };

  const signingBizMilestones = seedTree('Укладка ламината', [{ title: 'Укладка ламината, 42 м²', amount: '63000.00' }]);
  const signingBizParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    {
      profile_id: 'pf-masterremont-2',
      display_name: 'Мастер Ремонт',
      handle: '@masterremont',
      role: 'contractor',
      signer_note: 'Подписывает Дмитрий Мастеров, ИП «Мастер Ремонт» — по праву единоличного исполнительного органа',
    },
  ];
  const signingBizVersion = makeVersion({
    title: 'Укладка ламината, 42 м²',
    total: RUB('63000.00'),
    milestones: signingBizMilestones,
    parties: signingBizParties,
    sphere: 'Ремонт',
    protection_level: 'direct_platform',
  });
  // (b) Исполнитель-бизнес — заказчик уже подписал, ждём подпись исполнителя (финмодель v2: без комиссии).
  const signingBiz: ContractDetail = {
    id: 'c-3004',
    title: 'Укладка ламината, 42 м²',
    body_kind: 'template',
    status: 'awaiting_signatures',
    segment: 'paid_business',
    sphere: 'Ремонт',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: signingBizParties,
    initiator_role: 'customer',
    total: RUB('63000.00'),
    milestones: signingBizMilestones,
    revisions: [],
    preapproved_alternatives: [],
    version: signingBizVersion,
    signatures: [{ role: 'customer', signatory_name: 'Годвин', signed_at: t, integrity_hash: signingBizVersion.integrity_hash }],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(RUB('63000.00'), 'paid_business', 'RU'),
    ai_summary_shown: true,
    payout_account_id: 'po-seed-1',
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'signature.requested', actor_role: 'system', text: 'Запрошены подписи сторон' },
      { id: nid('ev'), at: t, kind: 'signed.partial', actor_role: 'customer', text: 'Подписано стороной: заказчик' },
    ],
    created_at: t,
    updated_at: t,
  };

  // (e) «Другая юрисдикция» демо (DEV-05-PATCH §5): C2C без комиссии за заключение,
  // но перевод платный — платформа берёт тариф оператора с плательщика.
  const otherJurisdictionMilestones = seedTree('Перевод статьи', [{ title: 'Перевод статьи на английский', amount: '90.00' }]);
  const otherJurisdictionParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-translator', display_name: 'Jonas Bergström', handle: '@jonasb', role: 'contractor' },
  ];
  const otherJurisdictionVersion = makeVersion({
    title: 'Перевод статьи, en→ru',
    total: { amount: '90.00', currency: 'USD' },
    milestones: otherJurisdictionMilestones,
    parties: otherJurisdictionParties,
    sphere: 'Переводы',
    protection_level: 'none',
  });
  const otherJurisdiction: ContractDetail = {
    id: 'c-3005',
    title: 'Перевод статьи, en→ru',
    body_kind: 'template',
    status: 'awaiting_signatures',
    segment: 'free_c2c',
    sphere: 'Переводы',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'none',
    parties: otherJurisdictionParties,
    initiator_role: 'customer',
    total: { amount: '90.00', currency: 'USD' },
    milestones: otherJurisdictionMilestones,
    revisions: [],
    preapproved_alternatives: [],
    version: otherJurisdictionVersion,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy({ amount: '90.00', currency: 'USD' }, 'free_c2c', 'OTHER'),
    ai_summary_shown: true,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'signature.requested', actor_role: 'system', text: 'Запрошены подписи сторон' },
    ],
    created_at: t,
    updated_at: t,
  };

  // ── DEV-16b · seed для языкового слоя подписания: своя редакция (custom_terms,
  // не переводится платформой) + официальный текст English (versionRenders — en/ru). ──
  const customTermsMilestones = seedTree('Разработка лендинга', [{ title: 'Лендинг на Tilda', amount: '35000.00' }]);
  const customTermsParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-webstudio-1', display_name: 'Студия «Вектор»', handle: '@vektorstudio', role: 'contractor' },
  ];
  const customTermsVersion = makeVersion({
    title: 'Разработка лендинга',
    total: RUB('35000.00'),
    milestones: customTermsMilestones,
    parties: customTermsParties,
    sphere: 'Веб-разработка',
    protection_level: 'direct_platform',
  });
  const customTermsContract: ContractDetail = {
    id: 'c-3006',
    title: 'Разработка лендинга',
    body_kind: 'custom',
    custom_terms: {
      author_lang: 'ru',
      text: 'Исполнитель разрабатывает лендинг на платформе Tilda по брифу заказчика, включая один блок правок по замечаниям после сдачи. Исходники передаются заказчику в формате экспорта Tilda. Хостинг и домен — на стороне заказчика.',
    },
    status: 'awaiting_signatures',
    segment: 'free_c2c',
    sphere: 'Веб-разработка',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: customTermsParties,
    initiator_role: 'customer',
    total: RUB('35000.00'),
    milestones: customTermsMilestones,
    revisions: [],
    preapproved_alternatives: [],
    version: customTermsVersion,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(RUB('35000.00'), 'free_c2c', 'RU'),
    ai_summary_shown: true,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'signature.requested', actor_role: 'system', text: 'Запрошены подписи сторон' },
    ],
    created_at: t,
    updated_at: t,
  };

  // ── DEV-06 · seed для карточки договора (§6): исполняемый договор, 4 этапа,
  // заказчик оплатил этап 1 (accepted → paid в /payment-plan), симметричное «внимание». ──
  const cardRootId = nid('ms');
  const cardStage1Id = nid('ms');
  const cardStage2Id = nid('ms');
  const cardStage3Id = nid('ms');
  const cardStage4Id = nid('ms');
  const cardMilestones: MilestoneNode[] = [
    { id: cardRootId, parent_id: null, title: 'Ремонт кухни', kind: 'branch', amount: null, depth: 0, checklist_items: [], materials: [] },
    {
      id: cardStage1Id,
      parent_id: cardRootId,
      title: 'Демонтаж старого гарнитура',
      kind: 'leaf',
      amount: RUB('20000.00'),
      depth: 1,
      checklist_items: [{ id: nid('cl'), text: 'Критерий приёмки: демонтаж выполнен, мусор вывезен', required_evidence: true }],
      materials: [],
      status: 'paid',
      meta: 'Оплачен 28 июля',
    },
    {
      id: cardStage2Id,
      parent_id: cardRootId,
      title: 'Черновая отделка',
      kind: 'leaf',
      amount: RUB('50000.00'),
      depth: 1,
      checklist_items: [{ id: nid('cl'), text: 'Критерий приёмки: стяжка и штукатурка готовы', required_evidence: true }],
      materials: [],
      status: 'under_acceptance',
      meta: 'Сдан вчера — ждёт приёмки',
    },
    {
      id: cardStage3Id,
      parent_id: cardRootId,
      title: 'Монтаж гарнитура',
      kind: 'leaf',
      amount: RUB('45000.00'),
      depth: 1,
      checklist_items: [{ id: nid('cl'), text: 'Критерий приёмки: гарнитур собран и закреплён', required_evidence: true }],
      materials: [
        {
          id: nid('mat'),
          catalog_ref: 'cat-kitchen-set',
          title: 'Кухонный гарнитур (комплект)',
          description: 'Корпуса + фасады, по проекту',
          price: null,
          price_by: 'customer',
          delivery_days_from_event: null,
          supplied_by: 'Заказчик',
          due: '10 августа',
          state: 'received',
        } satisfies ContractMaterial,
        {
          id: nid('mat'),
          catalog_ref: 'cat-sink',
          title: 'Мойка врезная',
          description: 'Сталь, 60×50 см',
          price: null,
          price_by: 'customer',
          delivery_days_from_event: null,
          supplied_by: 'Заказчик',
          due: '10 августа',
          state: 'problem',
        } satisfies ContractMaterial,
      ],
      status: 'in_progress',
      meta: 'Срок до 12 августа',
    },
    {
      id: cardStage4Id,
      parent_id: cardRootId,
      title: 'Финальная уборка',
      kind: 'leaf',
      amount: RUB('5000.00'),
      depth: 1,
      checklist_items: [{ id: nid('cl'), text: 'Критерий приёмки: помещение готово к сдаче', required_evidence: true }],
      materials: [],
      status: 'waiting_gate',
      meta: 'После этапа 3',
    },
  ];
  const cardParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    {
      profile_id: 'pf-masterremont-3',
      display_name: 'Мастер Ремонт',
      handle: '@masterremont',
      role: 'contractor',
      signer_note: 'Подписывает Дмитрий Мастеров, ИП «Мастер Ремонт» — по праву единоличного исполнительного органа',
    },
  ];
  const cardTotal = leafSum(cardMilestones);
  const cardVersion = makeVersion({
    title: 'Ремонт кухни, 12 м²',
    total: cardTotal,
    milestones: cardMilestones,
    parties: cardParties,
    sphere: 'Ремонт',
    protection_level: 'direct_platform',
  });
  const cardAttention: ContractAttention = {
    kind: 'accept_milestone',
    milestone_id: cardStage2Id,
    deadline: new Date(Date.now() + 100 * 60_000).toISOString(),
    views: {
      customer: {
        title: 'Этап «Черновая отделка» ждёт вашей приёмки',
        primary: { label: 'Принять', route: 'accept' },
      },
      contractor: {
        title: 'Ждём приёмку этапа «Черновая отделка» заказчиком',
        info: {
          text: 'Заказчик получил уведомление — приёмка обычно занимает 1–2 дня.',
          secondaryLabel: 'Напомнить',
          secondaryRoute: 'remind',
        },
      },
    },
  };
  const inProgress: ContractDetail = {
    id: 'c-4001',
    title: 'Ремонт кухни, 12 м²',
    no: '№ Р-2026-0412',
    body_kind: 'template',
    status: 'signed',
    execution: 'in_progress',
    segment: 'paid_business',
    sphere: 'Ремонт',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: cardParties,
    initiator_role: 'customer',
    total: cardTotal,
    payment_method: 'sbp',
    milestones: cardMilestones,
    revisions: [],
    preapproved_alternatives: [],
    version: cardVersion,
    signatures: [
      { role: 'customer', signatory_name: 'Годвин', signed_at: t, integrity_hash: cardVersion.integrity_hash },
      { role: 'contractor', signatory_name: 'Дмитрий Мастеров', signed_at: t, integrity_hash: cardVersion.integrity_hash },
    ],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(cardTotal, 'paid_business', 'RU'),
    ai_summary_shown: true,
    payout_account_id: 'po-seed-1',
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'contract.signed', actor_role: 'system', text: 'Договор подписан обеими сторонами' },
    ],
    amendments: [],
    dates: { start: t, nearest: new Date(Date.now() + 12 * 86_400_000).toISOString() },
    warranty_until: null,
    termination: null,
    attention: cardAttention,
    created_at: t,
    updated_at: t,
  };

  // ── DEV-07 · seed-варианты для платежа + плана расчётов (§6) ──
  function payLeaf(parentId: string, title: string, amount: string, status: StageStatus, meta: string): MilestoneNode {
    return {
      id: nid('ms'),
      parent_id: parentId,
      title,
      kind: 'leaf',
      amount: RUB(amount),
      depth: 1,
      checklist_items: [{ id: nid('cl'), text: `Критерий приёмки: ${title.toLowerCase()} выполнено`, required_evidence: true }],
      materials: [],
      status,
      meta,
    };
  }

  // (a) Этап принят, оплаты ещё нет — свежий вход в оплату («Оплатить» → PaymentPage).
  const payRootA = nid('ms');
  const payMilestonesA: MilestoneNode[] = [
    { id: payRootA, parent_id: null, title: 'Ремонт ванной', kind: 'branch', amount: null, depth: 0, checklist_items: [], materials: [] },
    payLeaf(payRootA, 'Демонтаж и гидроизоляция', '12000.00', 'paid', 'Оплачен 20 июля'),
    payLeaf(payRootA, 'Укладка плитки', '18000.00', 'accepted', 'Принят 1 августа — можно оплатить'),
    payLeaf(payRootA, 'Сантехника и финал', '10000.00', 'waiting_gate', 'После этапа 2'),
  ];
  const payPartiesA: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-dorofeev', display_name: 'Павел Дорофеев', handle: '@dorofeev_remont', role: 'contractor' },
  ];
  const payTotalA = leafSum(payMilestonesA);
  const payVersionA = makeVersion({
    title: 'Ремонт ванной, 6 м²',
    total: payTotalA,
    milestones: payMilestonesA,
    parties: payPartiesA,
    sphere: 'Ремонт',
    protection_level: 'direct_platform',
  });
  const paymentDue: ContractDetail = {
    id: 'c-5001',
    title: 'Ремонт ванной, 6 м²',
    no: '№ Р-2026-0501',
    body_kind: 'template',
    status: 'signed',
    execution: 'in_progress',
    segment: 'free_c2c',
    sphere: 'Ремонт',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: payPartiesA,
    initiator_role: 'customer',
    total: payTotalA,
    payment_method: 'sbp',
    milestones: payMilestonesA,
    revisions: [],
    preapproved_alternatives: [],
    version: payVersionA,
    signatures: [
      { role: 'customer', signatory_name: 'Годвин', signed_at: t, integrity_hash: payVersionA.integrity_hash },
      { role: 'contractor', signatory_name: 'Павел Дорофеев', signed_at: t, integrity_hash: payVersionA.integrity_hash },
    ],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(payTotalA, 'free_c2c', 'RU'),
    ai_summary_shown: true,
    payout_account_id: 'po-seed-1',
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'contract.signed', actor_role: 'system', text: 'Договор подписан обеими сторонами' },
    ],
    amendments: [],
    dates: { start: t, nearest: null },
    warranty_until: null,
    termination: null,
    attention: null,
    created_at: t,
    updated_at: t,
  };

  // (b)(c)(d) Этапы с уже начатыми платежами — онлайн pending, наличные ждут получателя, failed.
  const payRootB = nid('ms');
  const stageOnline = payLeaf(payRootB, 'Поклейка обоев, комната А', '20000.00', 'accepted', 'Платёж СБП обрабатывается');
  const stageCash = payLeaf(payRootB, 'Поклейка обоев, комната Б', '15000.00', 'accepted', 'Ждём подтверждения исполнителем');
  const stageFailed = payLeaf(payRootB, 'Поклейка обоев, комната В', '8000.00', 'accepted', 'Платёж не прошёл — можно повторить');
  const payMilestonesB: MilestoneNode[] = [
    { id: payRootB, parent_id: null, title: 'Поклейка обоев', kind: 'branch', amount: null, depth: 0, checklist_items: [], materials: [] },
    stageOnline,
    stageCash,
    stageFailed,
  ];
  const payPartiesB: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-kim', display_name: 'Светлана Ким', handle: '@kim_remont', role: 'contractor' },
  ];
  const payTotalB = leafSum(payMilestonesB);
  const payVersionB = makeVersion({
    title: 'Поклейка обоев, три комнаты',
    total: payTotalB,
    milestones: payMilestonesB,
    parties: payPartiesB,
    sphere: 'Ремонт',
    protection_level: 'direct_platform',
  });
  const paymentInFlight: ContractDetail = {
    id: 'c-5002',
    title: 'Поклейка обоев, три комнаты',
    no: '№ Р-2026-0502',
    body_kind: 'template',
    status: 'signed',
    execution: 'in_progress',
    segment: 'free_c2c',
    sphere: 'Ремонт',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: payPartiesB,
    initiator_role: 'customer',
    total: payTotalB,
    payment_method: 'sbp',
    milestones: payMilestonesB,
    revisions: [],
    preapproved_alternatives: [],
    version: payVersionB,
    signatures: [
      { role: 'customer', signatory_name: 'Годвин', signed_at: t, integrity_hash: payVersionB.integrity_hash },
      { role: 'contractor', signatory_name: 'Светлана Ким', signed_at: t, integrity_hash: payVersionB.integrity_hash },
    ],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(payTotalB, 'free_c2c', 'RU'),
    ai_summary_shown: true,
    payout_account_id: 'po-seed-1',
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'contract.signed', actor_role: 'system', text: 'Договор подписан обеими сторонами' },
    ],
    amendments: [],
    dates: { start: t, nearest: null },
    warranty_until: null,
    termination: null,
    attention: null,
    created_at: t,
    updated_at: t,
  };

  // (e) Юрисдикция без онлайн-провайдера — только наличные, без переключателя способа.
  const payRootE = nid('ms');
  const payMilestonesE: MilestoneNode[] = [
    { id: payRootE, parent_id: null, title: 'Перевозка мебели', kind: 'branch', amount: null, depth: 0, checklist_items: [], materials: [] },
    payLeaf(payRootE, 'Перевозка мебели, 1 комната', '6000.00', 'accepted', 'Принят — можно оплатить'),
  ];
  const payPartiesE: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-volkov', display_name: 'Артём Волков', handle: '@volkov_gruzchik', role: 'contractor' },
  ];
  const payTotalE = leafSum(payMilestonesE);
  const payVersionE = makeVersion({
    title: 'Перевозка мебели',
    total: payTotalE,
    milestones: payMilestonesE,
    parties: payPartiesE,
    sphere: 'Переезды',
    protection_level: 'direct_platform',
  });
  const paymentNoProvider: ContractDetail = {
    id: 'c-5005',
    title: 'Перевозка мебели',
    no: '№ Р-2026-0505',
    body_kind: 'template',
    status: 'signed',
    execution: 'in_progress',
    segment: 'free_c2c',
    sphere: 'Переезды',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: payPartiesE,
    initiator_role: 'customer',
    total: payTotalE,
    payment_method: 'cash',
    milestones: payMilestonesE,
    revisions: [],
    preapproved_alternatives: [],
    version: payVersionE,
    signatures: [
      { role: 'customer', signatory_name: 'Годвин', signed_at: t, integrity_hash: payVersionE.integrity_hash },
      { role: 'contractor', signatory_name: 'Артём Волков', signed_at: t, integrity_hash: payVersionE.integrity_hash },
    ],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(payTotalE, 'free_c2c', 'NO_PROVIDER'),
    ai_summary_shown: true,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'contract.signed', actor_role: 'system', text: 'Договор подписан обеими сторонами' },
    ],
    amendments: [],
    dates: { start: t, nearest: null },
    warranty_until: null,
    termination: null,
    attention: null,
    created_at: t,
    updated_at: t,
  };

  // ── DEV-10 · seed для экрана согласования (протокол разногласий, §7) ──
  const reviewParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-masterremont-4', display_name: 'Мастер Ремонт', handle: '@masterremont', role: 'contractor' },
  ];
  const reviewMilestones = seedTree('Ремонт кухни', [
    { title: 'Демонтаж', amount: '20000.00' },
    { title: 'Черновые работы', amount: '50000.00' },
    { title: 'Чистовая отделка', amount: '50000.00' },
  ]);
  const reviewLeaves = reviewMilestones.filter((m) => m.kind === 'leaf');
  const reviewTotal = leafSum(reviewMilestones);

  // (a) чужая мультивариант «ваш ход» — исполнитель просит доплату за декоративную штукатурку.
  const revCounterpartyMulti: RevisionProposal = {
    id: nid('rev'),
    author_role: 'contractor',
    item_ref: `milestone:${reviewLeaves[2]!.id}:amount`,
    item_label: 'Этап 3 · Чистовая отделка · сумма',
    before: '50 000 ₽',
    after: '55 000 ₽',
    variants: [
      { id: nid('var'), value: '55 000 ₽', note: 'с учётом декоративной штукатурки одной стены' },
      { id: nid('var'), value: '58 000 ₽', note: 'с декоративной штукатуркой и доставкой материала' },
    ],
    comment: 'Заказчик попросил добавить декоративную штукатурку на одну стену',
    status: 'open',
    financially_material: true,
    kind: 'proposal',
    created_at: t,
  };
  // (a) ваша мультивариант «ожидает» — заказчик предлагает сэкономить на стяжке.
  const revMineWaiting: RevisionProposal = {
    id: nid('rev'),
    author_role: 'customer',
    item_ref: `milestone:${reviewLeaves[1]!.id}:amount`,
    item_label: 'Этап 2 · Черновые работы · сумма',
    before: '50 000 ₽',
    after: '47 000 ₽',
    variants: [
      { id: nid('var'), value: '47 000 ₽', note: 'без стяжки — заказчик делает сам' },
      { id: nid('var'), value: '45 000 ₽', note: 'без стяжки и штукатурки одной стены' },
    ],
    comment: '',
    status: 'open',
    financially_material: true,
    kind: 'proposal',
    created_at: t,
  };
  // (d) однозначная финансово значимая правка — попадает в сводку «Принять все».
  const revSingleMaterial: RevisionProposal = {
    id: nid('rev'),
    author_role: 'contractor',
    item_ref: `milestone:${reviewLeaves[0]!.id}:amount`,
    item_label: 'Этап 1 · Демонтаж · сумма',
    before: '20 000 ₽',
    after: '22 000 ₽',
    variants: [{ id: nid('var'), value: '22 000 ₽', note: 'вывоз строительного мусора отдельным контейнером' }],
    comment: 'Объём мусора больше, чем закладывали изначально',
    status: 'open',
    financially_material: true,
    kind: 'proposal',
    created_at: t,
  };
  // (a) предодобренная альтернатива автора — те же variants, приём в 1 клик.
  const reviewPreapproved: PreapprovedAlternative[] = [
    {
      id: nid('pa'),
      item_ref: 'term:warranty',
      item_label: 'Гарантия',
      before: '12 мес.',
      after: '18 мес.',
      variants: [
        { id: nid('var'), value: '18 мес.' },
        { id: nid('var'), value: '24 мес.', note: 'расширенная — за отдельную плату материалов' },
      ],
    },
  ];
  const c6001: ContractDetail = {
    id: 'c-6001',
    title: 'Ремонт кухни, согласование',
    no: '№ Р-2026-0601',
    body_kind: 'template',
    status: 'under_review',
    segment: 'paid_business',
    sphere: 'Ремонт',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'direct_platform',
    parties: reviewParties,
    initiator_role: 'customer',
    total: reviewTotal,
    milestones: reviewMilestones,
    revisions: [revCounterpartyMulti, revMineWaiting, revSingleMaterial],
    preapproved_alternatives: reviewPreapproved,
    version: null,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(reviewTotal, 'paid_business', 'RU'),
    ai_summary_shown: false,
    payout_account_id: 'po-seed-1',
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'negotiation.sent', actor_role: 'customer', text: 'Отправлено контрагенту на согласование' },
      { id: nid('ev'), at: t, kind: 'revision.proposed', actor_role: 'contractor', text: `Предложена правка: ${revCounterpartyMulti.item_label}` },
      { id: nid('ev'), at: t, kind: 'revision.proposed', actor_role: 'customer', text: `Предложена правка: ${revMineWaiting.item_label}` },
      { id: nid('ev'), at: t, kind: 'revision.proposed', actor_role: 'contractor', text: `Предложена правка: ${revSingleMaterial.item_label}` },
    ],
    contract_kind: 'service',
    terms: { ...DEFAULT_TERMS },
    created_at: t,
    updated_at: t,
  };

  // (e) 0 открытых правок — «Заморозить и подписать» активна.
  const freezeReadyMilestones = seedTree('Поклейка обоев', [{ title: 'Поклейка обоев, комната 2', amount: '14000.00' }]);
  const freezeReadyParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-grom-2', display_name: 'Николай Гром', handle: '@grom_master', role: 'contractor' },
  ];
  const freezeReadyTotal = leafSum(freezeReadyMilestones);
  const c6002: ContractDetail = {
    id: 'c-6002',
    title: 'Поклейка обоев, комната 2',
    no: '№ Р-2026-0602',
    body_kind: 'template',
    status: 'under_review',
    segment: 'free_c2c',
    sphere: 'Ремонт',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'none',
    parties: freezeReadyParties,
    initiator_role: 'customer',
    total: freezeReadyTotal,
    milestones: freezeReadyMilestones,
    revisions: [],
    preapproved_alternatives: [],
    version: null,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(freezeReadyTotal, 'free_c2c', 'RU'),
    ai_summary_shown: false,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'negotiation.sent', actor_role: 'customer', text: 'Отправлено контрагенту на согласование' },
    ],
    contract_kind: 'service',
    terms: { ...DEFAULT_TERMS },
    created_at: t,
    updated_at: t,
  };

  // (f) терминальные выходы — без влияния на репутацию.
  const terminalMilestonesW = seedTree('Сборка стеллажа', [{ title: 'Сборка стеллажа', amount: '3500.00' }]);
  const terminalPartiesW: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-sborka', display_name: 'Олег Сборкин', handle: '@sborka_master', role: 'contractor' },
  ];
  const terminalTotalW = leafSum(terminalMilestonesW);
  const c6003: ContractDetail = {
    id: 'c-6003',
    title: 'Сборка стеллажа',
    no: '№ Р-2026-0603',
    body_kind: 'template',
    status: 'withdrawn_by_initiator',
    segment: 'free_c2c',
    sphere: 'Сборка мебели',
    contract_type: 'furniture_assembly',
    tax_note: null,
    protection_level: 'none',
    parties: terminalPartiesW,
    initiator_role: 'customer',
    total: terminalTotalW,
    milestones: terminalMilestonesW,
    revisions: [],
    preapproved_alternatives: [],
    version: null,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(terminalTotalW, 'free_c2c', 'RU'),
    ai_summary_shown: false,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'negotiation.sent', actor_role: 'customer', text: 'Отправлено контрагенту на согласование' },
      { id: nid('ev'), at: t, kind: 'withdrawn', actor_role: 'customer', text: 'Инициатор отозвал договор' },
    ],
    contract_kind: 'service',
    terms: { ...DEFAULT_TERMS },
    created_at: t,
    updated_at: t,
  };

  const terminalMilestonesR = seedTree('Установка розеток', [{ title: 'Установка розеток', amount: '6000.00' }]);
  const terminalPartiesR: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-electric-2', display_name: 'Игорь Электриков', handle: '@electric_master', role: 'contractor' },
  ];
  const terminalTotalR = leafSum(terminalMilestonesR);
  const c6004: ContractDetail = {
    id: 'c-6004',
    title: 'Установка розеток',
    no: '№ Р-2026-0604',
    body_kind: 'template',
    status: 'rejected_by_counterparty',
    segment: 'free_c2c',
    sphere: 'Электрика',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'none',
    parties: terminalPartiesR,
    initiator_role: 'customer',
    total: terminalTotalR,
    milestones: terminalMilestonesR,
    revisions: [],
    preapproved_alternatives: [],
    version: null,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(terminalTotalR, 'free_c2c', 'RU'),
    ai_summary_shown: false,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'negotiation.sent', actor_role: 'customer', text: 'Отправлено контрагенту на согласование' },
      { id: nid('ev'), at: t, kind: 'rejected', actor_role: 'contractor', text: 'Договор отклонён контрагентом' },
    ],
    contract_kind: 'service',
    terms: { ...DEFAULT_TERMS },
    created_at: t,
    updated_at: t,
  };

  // (g) вход из №5 «Отклонить на доработку» — комментарий подписанта первой правкой.
  const signerNoteMilestones = seedTree('Электрика в квартире', [{ title: 'Замена проводки', amount: '35000.00' }]);
  const signerNoteParties: ContractDetail['parties'] = [
    { profile_id: ME_PERSON.profile_id, display_name: ME_PERSON.display_name, handle: ME_PERSON.handle, role: 'customer' },
    { profile_id: 'pf-electric-3', display_name: 'Игорь Электриков', handle: '@electric_master', role: 'contractor' },
  ];
  const signerNoteText = 'Проверьте, пожалуйста, смету по розеткам в кухне — кажется, забыли 2 штуки';
  const signerNoteRevision: RevisionProposal = {
    id: nid('rev'),
    author_role: 'contractor',
    item_ref: 'general:decline',
    item_label: 'Комментарий подписанта',
    before: '',
    after: signerNoteText,
    variants: [{ id: nid('var'), value: signerNoteText }],
    comment: '',
    status: 'open',
    financially_material: false,
    kind: 'proposal',
    created_at: t,
  };
  const signerNoteTotal = leafSum(signerNoteMilestones);
  const c6005: ContractDetail = {
    id: 'c-6005',
    title: 'Электрика в квартире',
    no: '№ Р-2026-0605',
    body_kind: 'template',
    status: 'under_review',
    segment: 'free_c2c',
    sphere: 'Электрика',
    contract_type: 'repair_works',
    tax_note: null,
    protection_level: 'none',
    parties: signerNoteParties,
    initiator_role: 'customer',
    total: signerNoteTotal,
    milestones: signerNoteMilestones,
    revisions: [signerNoteRevision],
    preapproved_alternatives: [],
    version: null,
    signatures: [],
    contract_fee: null,
    payment_policy: buildPaymentPolicy(signerNoteTotal, 'free_c2c', 'RU'),
    ai_summary_shown: false,
    payout_account_id: null,
    timeline: [
      { id: nid('ev'), at: t, kind: 'created', actor_role: 'customer', text: 'Черновик создан' },
      { id: nid('ev'), at: t, kind: 'negotiation.sent', actor_role: 'customer', text: 'Отправлено контрагенту на согласование' },
      { id: nid('ev'), at: t, kind: 'frozen', actor_role: 'system', text: 'Версия заморожена' },
      { id: nid('ev'), at: t, kind: 'signature.requested', actor_role: 'system', text: 'Запрошены подписи сторон' },
      { id: nid('ev'), at: t, kind: 'declined_for_revision', actor_role: 'system', text: 'Возвращено на доработку — подписи и версия аннулированы' },
    ],
    contract_kind: 'service',
    terms: { ...DEFAULT_TERMS },
    created_at: t,
    updated_at: t,
  };

  return [
    paid,
    free,
    signingFree,
    signingBiz,
    otherJurisdiction,
    customTermsContract,
    inProgress,
    paymentDue,
    paymentInFlight,
    paymentNoProvider,
    c6001,
    c6002,
    c6003,
    c6004,
    c6005,
  ];
}

export function resetContracts(): void {
  seq = 1000;
  contracts = makeSeed();
}
resetContracts();

// Реквизиты выплат (мок) — условие подписания платных сегментов.
let payoutAccounts: { id: string; kind: 'sbp' | 'card' | 'account'; masked: string }[] = [];
export function resetPayouts(): void {
  payoutAccounts = [];
}
resetPayouts();

// ─────────────────────────────────────────────────────────────
//  Операции
// ─────────────────────────────────────────────────────────────
export const db = {
  list: (): ContractDetail[] => contracts,
  get: (id: string): ContractDetail => {
    const c = contracts.find((x) => x.id === id);
    if (!c) throw new MockError(404, 'not_found', 'Договор не найден');
    return c;
  },

  /** DEV-06 §6 — дерево этапов исполнения (только листья, у веток статус/meta не задаются). */
  stages(id: string) {
    const c = this.get(id);
    return {
      results: c.milestones
        .filter((m) => m.kind === 'leaf')
        .map((m, i) => ({ id: m.id, ix: i + 1, name: m.title, meta: m.meta, sum: m.amount, status: m.status, materials: m.materials })),
    };
  },

  /**
   * DEV-06 §6 — план расчётов по листьям. DEV-07 §4: `due` — этап принят, оплаты ещё
   * нет (можно оплатить сейчас); `later` — этап ещё не принят; `paid` — оплачен.
   * `commission` — наследие мока (финмодель v2: всегда undefined, contract_fee не начисляется).
   */
  paymentPlan(id: string) {
    const c = this.get(id);
    const leaves = c.milestones.filter((m) => m.kind === 'leaf');
    return {
      rows: leaves.map((m) => ({
        id: m.id,
        stage: m.title,
        note: m.meta,
        amount: m.amount,
        state: m.status === 'paid' ? ('paid' as const) : m.status === 'accepted' ? ('due' as const) : ('later' as const),
      })),
      commission: c.contract_fee ? { status: c.contract_fee.status } : undefined,
    };
  },

  /** DEV-07 §4 — платёж состоялся (онлайн succeeded / наличные оба подтвердили): лист → paid. */
  markStagePaid(contractId: string, stageId: string): void {
    const c = this.get(contractId);
    const m = c.milestones.find((x) => x.id === stageId);
    if (!m) throw new MockError(404, 'not_found', 'Этап не найден');
    m.status = 'paid';
    pushEvent(c, 'stage.paid', 'system', `Этап «${m.title}» оплачен`);
    c.updated_at = now();
  },

  /** DEV-06 §6 — история: хроника + допники (пусто на договорах без допников). */
  history(id: string) {
    const c = this.get(id);
    return { events: c.timeline, amendments: c.amendments ?? [] };
  },

  payoutAccounts: () => payoutAccounts,

  addPayoutAccount(kind: 'sbp' | 'card' | 'account', masked: string) {
    const acc = { id: nid('po'), kind, masked };
    payoutAccounts.push(acc);
    return acc;
  },

  /**
   * DEV-09 §1 — создаёт черновик мастера сразу после выбора сценария («Тип»), до заполнения
   * остальных шагов. Вторая сторона появляется позже через `patchDraft({ counterparty })`.
   */
  createDraft(input: {
    contract_kind?: ContractKind;
    sphere?: string;
    work_type?: string;
    currency?: string;
    my_role: RevisionAuthorRole;
    acting_as: ProfileKind;
    /** ADR-050 «как в прошлый раз» (DEV-13 §6) — клонирует суть/этапы/условия источника. */
    source_contract_id?: string;
  }): ContractDetail {
    const source = input.source_contract_id ? this.get(input.source_contract_id) : null;
    if (!source && (!input.contract_kind || !input.currency)) {
      throw new MockError(422, 'contract_kind_required', 'Нужен тип договора и валюта.');
    }
    const me = input.acting_as === 'business' ? ME_BIZ : ME_PERSON;
    const t = now();
    const currency = input.currency ?? source!.total.currency;
    const zero: MoneyLike = { amount: '0.00', currency };
    const rootId = nid('ms');
    const c: ContractDetail = {
      id: nid('c'),
      title: source ? `${source.title} (копия)` : '',
      body_kind: source?.body_kind ?? 'template',
      status: 'draft',
      segment: 'free_c2c',
      sphere: source?.sphere ?? input.sphere ?? '',
      contract_type: source?.contract_type ?? input.work_type ?? input.contract_kind ?? '',
      tax_note: null, // нейтральный конструктор (GLOBAL У1, док 31) — без налоговых пометок
      protection_level: source?.protection_level ?? 'cash', // DEV-09 §4.4: оплата вне платформы (ADR-060)
      parties: [
        { profile_id: me.profile_id, display_name: me.display_name, handle: me.handle, role: input.my_role },
      ],
      initiator_role: input.my_role,
      total: zero,
      milestones: source ? cloneMilestoneTree(source.milestones) : [
        { id: rootId, parent_id: null, title: 'Этапы работ', kind: 'branch', amount: null, depth: 0, checklist_items: [], materials: [] },
      ],
      revisions: [],
      preapproved_alternatives: [],
      version: null,
      signatures: [],
      contract_fee: null,
      payment_policy: buildPaymentPolicy(zero, 'free_c2c', 'RU'),
      ai_summary_shown: false,
      payout_account_id: null,
      timeline: [
        {
          id: nid('ev'),
          at: t,
          kind: 'created',
          actor_role: input.my_role,
          text: source ? `Черновик создан — «как в прошлый раз» (${source.title})` : 'Черновик создан',
        },
      ],
      contract_kind: source?.contract_kind ?? input.contract_kind,
      work_type: source?.work_type ?? input.work_type,
      form_data: source ? { ...source.form_data } : {},
      party_details: {},
      terms: source?.terms ? { ...source.terms } : { ...DEFAULT_TERMS },
      created_at: t,
      updated_at: t,
    };
    c.payment_policy.currency = currencyPolicyFor(currency);
    contracts.unshift(c);
    return c;
  },

  /** DEV-13 §5/§7 — удалить черновик (только не отправленный на согласование). */
  deleteDraft(id: string): { deleted: true } {
    const c = this.get(id);
    if (c.status !== 'draft') {
      throw new MockError(409, 'invalid_state_transition', 'Удалить можно только черновик.');
    }
    contracts = contracts.filter((x) => x.id !== id);
    return { deleted: true };
  },

  /**
   * DEV-09 §1/§7 — автосейв шагов мастера: `form_data`, реквизиты стороны, валюта,
   * общие условия, контрагент (или инвайт незарегистрированного). Один хендлер на все
   * PATCH-поля шага, т.к. каждый шаг сохраняет только свой кусок.
   */
  patchDraft(
    id: string,
    partial: {
      title?: string;
      sphere?: string;
      work_type?: string;
      body_kind?: 'template' | 'custom';
      protection_level?: ProtectionLevel;
      currency?: string;
      form_data?: Record<string, unknown>;
      terms?: Partial<ContractTerms>;
      party_details?: Partial<Record<RevisionAuthorRole, PartyDetails>>;
      counterparty?: { handle?: string; display_name: string; kind: ProfileKind };
    },
  ): ContractDetail {
    const c = db.get(id);
    assertEditable(c);

    if (partial.title !== undefined) c.title = partial.title;
    if (partial.sphere !== undefined) c.sphere = partial.sphere;
    if (partial.work_type !== undefined) c.work_type = partial.work_type;
    if (partial.body_kind !== undefined) c.body_kind = partial.body_kind;
    if (partial.protection_level !== undefined) c.protection_level = partial.protection_level;
    if (partial.form_data) c.form_data = { ...(c.form_data ?? {}), ...partial.form_data };
    if (partial.terms) c.terms = { ...(c.terms ?? DEFAULT_TERMS), ...partial.terms };
    if (partial.party_details) {
      c.party_details = { ...(c.party_details ?? {}) };
      for (const role of Object.keys(partial.party_details) as RevisionAuthorRole[]) {
        c.party_details[role] = partial.party_details[role];
      }
    }
    if (partial.currency) {
      const cur = partial.currency;
      c.total = { ...c.total, currency: cur };
      for (const m of c.milestones) if (m.amount) m.amount = { ...m.amount, currency: cur };
      c.payment_policy.currency = currencyPolicyFor(cur);
    }
    if (partial.counterparty) {
      const other = partial.counterparty;
      const otherRole: RevisionAuthorRole = c.initiator_role === 'customer' ? 'contractor' : 'customer';
      const existing = c.parties.find((p) => p.role === otherRole);
      const party = {
        profile_id: existing?.profile_id ?? nid('pf'),
        display_name: other.display_name,
        handle: other.handle ?? '',
        role: otherRole,
      };
      if (existing) Object.assign(existing, party);
      else c.parties.push(party);
      c.segment = recomputeSegmentForCounterparty(c, other.kind);
    }

    syncTotals(c);
    c.updated_at = now();
    return c;
  },

  /**
   * DEV-09 §4 — замена дерева этапов целиком (`PATCH .../milestones?view=tree`): проще для
   * клиента, который редактирует всё дерево локально (авто-разнос, чек-листы, материалы) и
   * сохраняет пачкой, чем пересобирать через add/update/remove по одному узлу.
   */
  replaceMilestoneTree(id: string, nodes: MilestoneNode[]): ContractDetail {
    const c = db.get(id);
    assertEditable(c);
    const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    if (maxDepth > 5) throw new MockError(422, 'milestone_depth_exceeded', 'Глубина дерева ограничена 6 уровнями');
    c.milestones = nodes.map((n) => ({ ...n, id: n.id || nid('ms') }));
    syncTotals(c);
    c.updated_at = now();
    return c;
  },

  addMilestone(id: string, input: { parent_id: string; title: string; kind: 'branch' | 'leaf'; amount?: string }): ContractDetail {
    const c = db.get(id);
    assertEditable(c);
    const parent = c.milestones.find((m) => m.id === input.parent_id);
    if (!parent) throw new MockError(422, 'invalid_parent', 'Родительский узел не найден');
    const depth = parent.depth + 1;
    if (depth > 5) throw new MockError(422, 'milestone_depth_exceeded', 'Глубина дерева ограничена 6 уровнями');
    // Родитель становится веткой при появлении детей.
    parent.kind = 'branch';
    parent.amount = null;
    c.milestones.push({
      id: nid('ms'),
      parent_id: input.parent_id,
      title: input.title,
      kind: input.kind,
      amount: input.kind === 'leaf' ? RUB(input.amount ?? '0.00') : null,
      depth,
      checklist_items: [],
      materials: [],
    });
    syncTotals(c);
    c.updated_at = now();
    return c;
  },

  updateMilestone(id: string, msId: string, input: { title?: string; amount?: string }): ContractDetail {
    const c = db.get(id);
    assertEditable(c);
    const m = c.milestones.find((x) => x.id === msId);
    if (!m) throw new MockError(404, 'not_found', 'Этап не найден');
    if (input.title !== undefined) m.title = input.title;
    if (input.amount !== undefined && m.kind === 'leaf') m.amount = RUB(input.amount);
    syncTotals(c);
    c.updated_at = now();
    return c;
  },

  removeMilestone(id: string, msId: string): ContractDetail {
    const c = db.get(id);
    assertEditable(c);
    const target = c.milestones.find((m) => m.id === msId);
    if (!target) throw new MockError(404, 'not_found', 'Этап не найден');
    if (target.parent_id === null) throw new MockError(422, 'cannot_remove_root', 'Корневой узел удалить нельзя');
    const toRemove = new Set<string>([msId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of c.milestones) {
        if (m.parent_id && toRemove.has(m.parent_id) && !toRemove.has(m.id)) {
          toRemove.add(m.id);
          grew = true;
        }
      }
    }
    c.milestones = c.milestones.filter((m) => !toRemove.has(m.id));
    syncTotals(c);
    c.updated_at = now();
    return c;
  },

  addMaterial(
    id: string,
    msId: string,
    input: { catalog_ref: string; title: string; description: string; price?: string; price_by: 'customer' | 'contractor'; delivery_days_from_event?: number },
  ): ContractDetail {
    const c = db.get(id);
    assertEditable(c);
    const m = c.milestones.find((x) => x.id === msId);
    if (!m) throw new MockError(404, 'not_found', 'Этап не найден');
    if (!input.description?.trim()) throw new MockError(422, 'material_description_required', 'Описание материала обязательно');
    if (input.price_by === 'contractor' && (!input.price || Number(input.price) <= 0)) {
      throw new MockError(422, 'material_price_required', 'Для материала исполнителя цена должна быть больше нуля');
    }
    m.materials.push({
      id: nid('mat'),
      catalog_ref: input.catalog_ref || 'Прочее',
      title: input.title,
      description: input.description,
      price: input.price ? RUB(input.price) : null,
      price_by: input.price_by,
      delivery_days_from_event: input.delivery_days_from_event ?? null,
    });
    c.updated_at = now();
    return c;
  },

  // ── Согласование (FSM §6.1) ──
  send(id: string, byRole: RevisionAuthorRole): ContractDetail {
    const c = db.get(id);
    // DEV-09 §8/§11 — валидации блокируют ОТПРАВКУ, не ввод; узко на черновиках мастера
    // (contract_kind задан), чтобы не задеть старые seed-договоры без этого поля.
    if (c.contract_kind === 'service' && !c.milestones.some((m) => m.kind === 'leaf')) {
      throw new MockError(422, 'no_stages', 'Добавьте хотя бы один этап');
    }
    if (c.contract_kind === 'sale') {
      const photos = c.form_data?.photos;
      if (!Array.isArray(photos) || photos.length === 0) {
        throw new MockError(422, 'sale_photo_required', 'Добавьте хотя бы одно фото товара');
      }
    }
    transition(c, 'under_review');
    pushEvent(c, 'negotiation.sent', byRole, 'Отправлено контрагенту на согласование');
    return c;
  },

  proposeRevision(
    id: string,
    input: {
      author_role: RevisionAuthorRole;
      item_ref: string;
      item_label: string;
      before: string;
      /** Ф2 (одиночная правка, ContractDetailPage NegoPanel) — используется, если `variants` не передан. */
      after?: string;
      /** DEV-10 §2 ⭐ — 1..N вариантов «стало». */
      variants?: { value: string; note?: string }[];
      comment: string;
      financially_material: boolean;
      kind?: RevisionProposal['kind'];
    },
  ): ContractDetail {
    const c = db.get(id);
    if (c.status !== 'under_review') {
      // Правка после заморозки возвращает в under_review (аннулирование подписей, ADR-006).
      if (c.status === 'pending_signature' || c.status === 'awaiting_signatures') {
        revertToReview(c);
      } else {
        throw new MockError(409, 'invalid_state_transition', 'Правки доступны только в согласовании');
      }
    }
    const draftVariants = input.variants && input.variants.length > 0 ? input.variants : [{ value: input.after ?? '' }];
    const variants: RevisionVariant[] = draftVariants.map((v) => ({ id: nid('var'), value: v.value, note: v.note }));
    c.revisions.push({
      id: nid('rev'),
      author_role: input.author_role,
      item_ref: input.item_ref,
      item_label: input.item_label,
      before: input.before,
      after: variants[0]!.value,
      variants,
      comment: input.comment,
      status: 'open',
      financially_material: input.financially_material,
      kind: input.kind ?? 'proposal',
      created_at: now(),
    });
    pushEvent(c, 'revision.proposed', input.author_role, `Предложена правка: ${input.item_label}`);
    return c;
  },

  /** Ф2 (наследие, ContractDetailPage NegoPanel) — одиночный приём/отклонение без выбора варианта. */
  respondRevision(id: string, revId: string, action: 'accept' | 'reject'): ContractDetail {
    const c = db.get(id);
    const r = c.revisions.find((x) => x.id === revId);
    if (!r) throw new MockError(404, 'not_found', 'Правка не найдена');
    if (r.status !== 'open') throw new MockError(409, 'revision_closed', 'Правка уже обработана');
    r.status = action === 'accept' ? 'accepted' : 'rejected';
    if (action === 'accept') {
      r.chosen_variant_id = r.variants[0]?.id;
      applyRevision(c, r);
    }
    pushEvent(c, action === 'accept' ? 'revision.accepted' : 'revision.rejected', r.author_role === 'customer' ? 'contractor' : 'customer', `Правка ${action === 'accept' ? 'принята' : 'отклонена'}: ${r.item_label}`);
    return c;
  },

  /** DEV-10 §4 — «Выбрать вариант» по чужой правке; симметрия — принять может только контрагент. */
  acceptRevision(id: string, revId: string, byRole: RevisionAuthorRole, variantId: string): ContractDetail {
    const c = db.get(id);
    const r = c.revisions.find((x) => x.id === revId);
    if (!r) throw new MockError(404, 'not_found', 'Правка не найдена');
    if (r.status !== 'open') throw new MockError(409, 'revision_closed', 'Правка уже обработана');
    if (r.author_role === byRole) throw new MockError(403, 'not_counterparty', 'Выбрать вариант может только контрагент');
    const variant = r.variants.find((v) => v.id === variantId);
    if (!variant) throw new MockError(404, 'not_found', 'Вариант не найден');
    r.status = 'accepted';
    r.chosen_variant_id = variant.id;
    r.after = variant.value;
    applyRevision(c, r);
    pushEvent(c, 'revision.accepted', byRole, `Правка принята: ${r.item_label} → ${variant.value}`);
    return c;
  },

  /** DEV-10 §4 — отклонение со свободным необязательным комментарием. */
  rejectRevision(id: string, revId: string, byRole: RevisionAuthorRole, comment?: string): ContractDetail {
    const c = db.get(id);
    const r = c.revisions.find((x) => x.id === revId);
    if (!r) throw new MockError(404, 'not_found', 'Правка не найдена');
    if (r.status !== 'open') throw new MockError(409, 'revision_closed', 'Правка уже обработана');
    if (r.author_role === byRole) throw new MockError(403, 'not_counterparty', 'Отклонить может только контрагент');
    r.status = 'rejected';
    pushEvent(c, 'revision.rejected', byRole, comment ? `Правка отклонена: ${r.item_label} — ${comment}` : `Правка отклонена: ${r.item_label}`);
    return c;
  },

  /**
   * DEV-10 §4 — встречная редакция: исходная правка → `countered` (наследие бэкенда —
   * `superseded`, techspec §8.4; на моке используем `countered` по тексту хай-фай, см.
   * TODO(Ф6) в типах), создаётся новая правка от контрагента с тем же item_ref.
   */
  counterRevision(id: string, revId: string, byRole: RevisionAuthorRole, variants: { value: string; note?: string }[], comment?: string): ContractDetail {
    const c = db.get(id);
    const r = c.revisions.find((x) => x.id === revId);
    if (!r) throw new MockError(404, 'not_found', 'Правка не найдена');
    if (r.status !== 'open') throw new MockError(409, 'revision_closed', 'Правка уже обработана');
    if (r.author_role === byRole) throw new MockError(403, 'not_counterparty', 'Встречную может предложить только контрагент');
    if (!variants || variants.length === 0) throw new MockError(422, 'variant_required', 'Укажите хотя бы один вариант');
    r.status = 'countered';
    const newVariants: RevisionVariant[] = variants.map((v) => ({ id: nid('var'), value: v.value, note: v.note }));
    c.revisions.push({
      id: nid('rev'),
      author_role: byRole,
      item_ref: r.item_ref,
      item_label: r.item_label,
      before: r.before,
      after: newVariants[0]!.value,
      variants: newVariants,
      comment: comment ?? '',
      status: 'open',
      financially_material: r.financially_material,
      kind: 'counter',
      created_at: now(),
    });
    pushEvent(c, 'revision.countered', byRole, `Встречная редакция: ${r.item_label}`);
    return c;
  },

  /** DEV-10 §4 — «Отозвать» по своей правке; только автор и только пока открыта. */
  withdrawRevision(id: string, revId: string, byRole: RevisionAuthorRole): ContractDetail {
    const c = db.get(id);
    const r = c.revisions.find((x) => x.id === revId);
    if (!r) throw new MockError(404, 'not_found', 'Правка не найдена');
    if (r.author_role !== byRole) throw new MockError(403, 'not_initiator', 'Отозвать может только автор правки');
    if (r.status !== 'open') throw new MockError(409, 'revision_closed', 'Правка уже обработана');
    r.status = 'withdrawn';
    pushEvent(c, 'revision.withdrawn', byRole, `Правка отозвана: ${r.item_label}`);
    return c;
  },

  /**
   * DEV-10 §5 — «Принять все»: только однозначные открытые правки (`variants.length===1`)
   * и предодобренные без выбора; многовариантные исключены (выбираются поштучно).
   */
  acceptAllRevisions(id: string, confirmSummary: boolean): ContractDetail {
    const c = db.get(id);
    const openSingle = c.revisions.filter((r) => r.status === 'open' && r.variants.length === 1);
    const preSingle = c.preapproved_alternatives.filter((a) => a.variants.length === 1);
    const material = openSingle.some((r) => r.financially_material);
    if (material && !confirmSummary) {
      throw new MockError(422, 'confirm_summary_required', 'Финансово значимые правки требуют подтверждения раскладки', {
        changes: openSingle.map((r) => ({ id: r.id, item_label: r.item_label, before: r.before, after: r.variants[0]!.value })),
        total_before: c.total,
        total_after: simulateTotalAfter(c, openSingle, preSingle),
      });
    }
    for (const r of openSingle) {
      r.status = 'accepted';
      r.chosen_variant_id = r.variants[0]!.id;
      r.after = r.variants[0]!.value;
      applyRevision(c, r);
    }
    for (const a of preSingle) {
      c.preapproved_alternatives = c.preapproved_alternatives.filter((x) => x.id !== a.id);
      applyItemChange(c, a.item_ref, a.variants[0]!.value);
    }
    if (openSingle.length + preSingle.length > 0) {
      pushEvent(c, 'revision.accepted', 'system', `Приняты все однозначные правки (${openSingle.length + preSingle.length})`);
    }
    return c;
  },

  /** DEV-10 §2/§4 — предодобренная альтернатива, приём в 1 клик по выбранному варианту. */
  applyPreapproved(id: string, altId: string, variantId: string): ContractDetail {
    const c = db.get(id);
    const alt = c.preapproved_alternatives.find((a) => a.id === altId);
    if (!alt) throw new MockError(404, 'not_found', 'Альтернатива не найдена');
    const variant = alt.variants.find((v) => v.id === variantId);
    if (!variant) throw new MockError(404, 'not_found', 'Вариант не найден');
    c.preapproved_alternatives = c.preapproved_alternatives.filter((a) => a.id !== altId);
    applyItemChange(c, alt.item_ref, variant.value);
    pushEvent(c, 'preapproved.applied', 'system', `Применён предодобренный вариант: ${alt.item_label} → ${variant.value}`);
    c.updated_at = now();
    return c;
  },

  withdraw(id: string, byRole: RevisionAuthorRole): ContractDetail {
    const c = db.get(id);
    if (byRole !== c.initiator_role) throw new MockError(403, 'not_initiator', 'Отозвать может только инициатор');
    transition(c, 'withdrawn_by_initiator');
    pushEvent(c, 'withdrawn', byRole, 'Инициатор отозвал договор');
    return c;
  },

  reject(id: string, byRole: RevisionAuthorRole): ContractDetail {
    const c = db.get(id);
    transition(c, 'rejected_by_counterparty');
    pushEvent(c, 'rejected', byRole, 'Договор отклонён контрагентом');
    return c;
  },

  // ── Заморозка ──
  freeze(id: string): ContractDetail {
    const c = db.get(id);
    if (c.status !== 'under_review') throw new MockError(409, 'invalid_state_transition', 'Заморозить можно только из согласования');
    if (c.revisions.some((r) => r.status === 'open')) {
      throw new MockError(422, 'open_revisions', 'Есть открытые правки — закройте их перед заморозкой');
    }
    const leaves = leafSum(c.milestones);
    if (leaves.amount !== c.total.amount) {
      throw new MockError(422, 'leaf_sum_mismatch', 'Сумма листьев не равна сумме договора', {
        leaf_sum: leaves,
        total: c.total,
      });
    }
    c.segment = recomputeSegment(c);
    c.payment_policy = recomputePaymentPolicy(c);
    if (isPaidSegment(c.segment) && !c.payout_account_id) {
      throw new MockError(409, 'requisites_missing', 'Заполните реквизиты выплат для платного сегмента');
    }
    const snapshotJson = JSON.stringify({ title: c.title, total: c.total, milestones: c.milestones, parties: c.parties });
    const t = now();
    const versionId = nid('ver');
    registerRenders(versionId, c);
    c.version = {
      id: versionId,
      integrity_hash: fakeHash(snapshotJson),
      tsa_time: t,
      ai_summary: buildAiSummary(c),
      ai_summary_items: buildAiSummaryItems(c),
      snapshot_total: c.total,
      created_at: t,
      official_language: 'en',
      is_cross_language: false,
      official_render: { lang: 'en', kind: 'human', body: buildOfficialRender(c) },
    };
    transition(c, 'pending_signature');
    pushEvent(c, 'frozen', 'system', `Версия заморожена · hash ${c.version.integrity_hash.slice(0, 10)}…`);
    return c;
  },

  setPayoutAccount(id: string, accountId: string): ContractDetail {
    const c = db.get(id);
    c.payout_account_id = accountId;
    c.updated_at = now();
    return c;
  },

  markAiSummaryShown(id: string): ContractDetail {
    const c = db.get(id);
    c.ai_summary_shown = true;
    return c;
  },

  // ── Подписание ──
  requestSignature(id: string): ContractDetail {
    const c = db.get(id);
    transition(c, 'awaiting_signatures');
    pushEvent(c, 'signature.requested', 'system', 'Запрошены подписи сторон');
    return c;
  },

  /** Финмодель v2: подписание больше не транзакция с комиссией — второй подписи достаточно для signed. */
  sign(id: string, role: RevisionAuthorRole, opts: { signatoryName?: string } = {}): ContractDetail {
    const c = db.get(id);
    if (c.status !== 'awaiting_signatures') throw new MockError(409, 'invalid_state_transition', 'Подпись доступна после запроса подписей');
    if (!c.version) throw new MockError(409, 'no_version', 'Нет замороженной версии');
    if (c.signatures.some((s) => s.role === role)) throw new MockError(409, 'already_signed', 'Эта сторона уже подписала');
    if (!c.ai_summary_shown) throw new MockError(422, 'ai_summary_not_shown', 'Перед подписью нужно показать резюме условий');

    c.signatures.push({
      role,
      signatory_name: opts.signatoryName ?? (role === 'customer' ? 'Годвин' : 'Контрагент'),
      signed_at: now(),
      integrity_hash: c.version.integrity_hash,
    });

    if (c.signatures.length < 2) {
      pushEvent(c, 'signed.partial', role, `Подписано стороной: ${role === 'customer' ? 'заказчик' : 'исполнитель'}`);
      return c;
    }

    transition(c, 'signed');
    pushEvent(c, 'contract.signed', 'system', 'Договор подписан обеими сторонами — по рукам!');
    return c;
  },

  /**
   * DEV-10 §6 — вход с №5 «Отклонить на доработку»: комментарий подписанта (если есть)
   * появляется на экране согласования заметкой/первой правкой общего уровня.
   */
  declineForRevision(id: string, byRole: RevisionAuthorRole, comment?: string): ContractDetail {
    const c = db.get(id);
    if (c.status !== 'awaiting_signatures' && c.status !== 'pending_signature') {
      throw new MockError(409, 'invalid_state_transition', 'Вернуть на доработку можно только на подписании');
    }
    revertToReview(c);
    const note = comment?.trim();
    if (note) {
      c.revisions.push({
        id: nid('rev'),
        author_role: byRole,
        item_ref: 'general:decline',
        item_label: 'Комментарий подписанта',
        before: '',
        after: note,
        variants: [{ id: nid('var'), value: note }],
        comment: '',
        status: 'open',
        financially_material: false,
        kind: 'proposal',
        created_at: now(),
      });
    }
    pushEvent(c, 'declined_for_revision', 'system', 'Возвращено на доработку — подписи и версия аннулированы');
    return c;
  },
};

/** Проекция полного договора в сводку для списка сделок (Ф1 DealsPage). */
const STATUS_MAP: Record<NegotiationStatus, ContractStatus> = {
  draft: 'draft',
  under_review: 'under_negotiation',
  pending_signature: 'pending_signature',
  awaiting_signatures: 'pending_signature',
  signed: 'active',
  rejected_by_counterparty: 'terminated',
  withdrawn_by_initiator: 'terminated',
};

/**
 * DEV-07 демо-договоры платежа (c-5001/c-5002/c-5005) — служебные фикстуры для прямого
 * захода по URL (как c-9001/c-9002 в acceptanceDb), в списке «Сделки» не нужны — иначе
 * сдвигают пагинацию для всех остальных мест, где список читается без фильтра.
 */
const DEALS_LIST_HIDDEN_IDS = new Set(['c-5001', 'c-5002', 'c-5005', 'c-6001', 'c-6002', 'c-6003', 'c-6004', 'c-6005']);

export function dbSummaries(): ContractSummary[] {
  return contracts.filter((c) => !DEALS_LIST_HIDDEN_IDS.has(c.id)).map((c) => {
    const mine = c.parties.find((p) => p.handle === ME_PERSON.handle || p.handle === ME_BIZ.handle);
    const myRole = mine?.role ?? 'customer';
    const leaves = c.milestones.filter((m) => m.kind === 'leaf').length;
    return {
      id: c.id,
      title: c.title,
      status: STATUS_MAP[c.status],
      segment: c.segment,
      sphere: c.sphere,
      my_role: myRole,
      parties: c.parties,
      total: c.total,
      payment_protected: c.protection_level === 'direct_platform',
      milestones_total: leaves,
      milestones_accepted: 0,
      updated_at: c.updated_at,
      acceptance_deadline: null,
    };
  });
}

// ── Внутренние ──
function assertEditable(c: ContractDetail): void {
  if (c.status !== 'draft' && c.status !== 'under_review') {
    throw new MockError(409, 'invalid_state_transition', 'Правки доступны только в черновике/согласовании');
  }
}

function transition(c: ContractDetail, to: NegotiationStatus): void {
  if (!canTransition(c.status, to)) {
    throw new MockError(409, 'invalid_state_transition', `Недопустимый переход ${c.status} → ${to}`);
  }
  c.status = to;
  c.updated_at = now();
}

/** Правка после заморозки → under_review, аннулирование версии и подписей (ADR-006). */
function revertToReview(c: ContractDetail): void {
  c.status = 'under_review';
  c.version = null;
  c.signatures = [];
  c.contract_fee = null;
  c.ai_summary_shown = false;
  c.updated_at = now();
}

/** Мок: правка/предодобренная вида «milestone:<id>:amount|title» применяется к дереву этапов. */
function applyItemChange(c: ContractDetail, itemRef: string, value: string): void {
  const [kind, ref, field] = itemRef.split(':');
  if (kind === 'milestone' && field === 'amount') {
    const m = c.milestones.find((x) => x.id === ref);
    if (m && m.kind === 'leaf') {
      const num = value.replace(/[^\d.]/g, '');
      if (num) m.amount = RUB(Number(num).toFixed(2));
    }
  } else if (kind === 'milestone' && field === 'title') {
    const m = c.milestones.find((x) => x.id === ref);
    if (m) m.title = value;
  }
  syncTotals(c);
}

function applyRevision(c: ContractDetail, r: RevisionProposal): void {
  applyItemChange(c, r.item_ref, r.after);
}

/** DEV-10 §5 — предпросмотр итога договора для `AcceptAllModal`, на копии, без побочных эффектов. */
function simulateTotalAfter(c: ContractDetail, singleRevisions: RevisionProposal[], singlePreapproved: PreapprovedAlternative[]): MoneyLike {
  const clone: ContractDetail = JSON.parse(JSON.stringify(c));
  for (const r of singleRevisions) applyItemChange(clone, r.item_ref, r.variants[0]!.value);
  for (const a of singlePreapproved) applyItemChange(clone, a.item_ref, a.variants[0]!.value);
  return clone.total;
}

function isPaidSegment(s: ContractSegment): boolean {
  return s === 'paid_c2c' || s === 'paid_business';
}

function recomputeSegmentForCounterparty(c: ContractDetail, counterpartyKind: ProfileKind): ContractSegment {
  const meBiz = c.parties.some((p) => p.handle === ME_BIZ.handle);
  const customer = c.parties.find((p) => p.role === 'customer');
  const meIsCustomer = customer?.handle === ME_PERSON.handle || customer?.handle === ME_BIZ.handle;
  const myKind: ProfileKind = meBiz ? 'business' : 'person';
  const customerKind = meIsCustomer ? myKind : counterpartyKind;
  const contractorKind = meIsCustomer ? counterpartyKind : myKind;
  return previewSegment({ customerKind, contractorKind, isPaid: c.protection_level === 'direct_platform' });
}

function buildAiSummary(c: ContractDetail): string {
  const leaves = c.milestones.filter((m) => m.kind === 'leaf').length;
  return (
    `Существенные условия: предмет — «${c.title}», ${leaves} оплачиваемых этапов, ` +
    `общая сумма ${c.total.amount} ${c.total.currency}. Уровень защиты платежа: ${protectionLabel(c.protection_level)}. ` +
    `Приёмка — по чек-листам этапов, оплата — по мере приёмки. ` +
    `Платформа выступает оператором, а не стороной сделки.`
  );
}

/** Структурированное AI-резюме для AiSummaryCard (DEV-05 §2) — что делаем/сроки/сумма/расчёт/приёмка. */
function buildAiSummaryItems(c: ContractDetail): { label: string; value: string }[] {
  const leaves = c.milestones.filter((m) => m.kind === 'leaf').length;
  return [
    { label: 'Что делаем', value: `${c.title} · ${c.sphere}` },
    { label: 'Этапы', value: `${leaves} оплачиваемых этапов, приёмка — по чек-листам` },
    { label: 'Сумма', value: `${c.total.amount} ${c.total.currency}` },
    { label: 'Расчёт', value: protectionLabel(c.protection_level) },
    { label: 'Приёмка', value: 'По мере готовности этапов, с чек-листом и доказательствами' },
  ];
}

function protectionLabel(p: ProtectionLevel): string {
  return { none: 'без защиты платежа', cash: 'наличные (без защиты)', prepayment: 'предоплата', direct_platform: 'платёж под защитой платформы' }[p];
}
