/**
 * Доменные типы договорного контура Ф2 (ручной срез; в Ф6 — из OpenAPI).
 * Клиент игнорирует неизвестные поля (техспецификация §7).
 */
import type { MoneyLike } from '../money';
import type { NegotiationStatus, ExecutionStatus } from '../fsm';
import type { PaymentPolicy } from '../payment-policy';
import type { ContractSegment, ContractSummary, DashboardPaymentMethod, ProfileKind } from './types';

export type { NegotiationStatus, ExecutionStatus };

/** Каталог типов договоров (excluded скрыт в UI, §8.5). */
export interface ContractType {
  code: string;
  name: string;
  sphere: string;
  tax_note: string | null;
  excluded: boolean;
}

/** Запись справочника хендлов для выбора контрагента. */
export interface HandleEntry {
  handle: string;
  display_name: string;
  kind: ProfileKind;
  verification_level: string;
}

/** Лестница защиты — честные подписи уровней (§8.5). */
export type ProtectionLevel = 'none' | 'cash' | 'prepayment' | 'direct_platform';

export interface ChecklistItem {
  id: string;
  text: string;
  /** Требуется доказательство для сдачи (Ф3). */
  required_evidence: boolean;
}

/** Состояние материала листа на карточке договора (DEV-06 §3, StageMaterials). */
export type MaterialState = 'received' | 'expected' | 'problem';

export interface ContractMaterial {
  id: string;
  catalog_ref: string;
  title: string;
  description: string;
  price: MoneyLike | null;
  /** Кто оплачивает материал; если исполнитель — цена > 0 (ADR-047). */
  price_by: 'customer' | 'contractor';
  /** Срок поставки как «N дней от события», не абсолютная дата (ADR-047). */
  delivery_days_from_event: number | null;
  /** Кто поставляет (имя/сторона) — только на исполняемых договорах (DEV-06). */
  supplied_by?: string;
  /** Ожидаемая дата поставки — только на исполняемых договорах (DEV-06). */
  due?: string | null;
  /** Статус материала — только на исполняемых договорах (DEV-06); проблема → окно оспаривания (ADR-019). */
  state?: MaterialState;
}

export type MilestoneKind = 'branch' | 'leaf';

/**
 * Статус листа в исполнении (DEV-06 §3, StageTree; техспецификация §6.3).
 * Только у листьев исполняемого договора (после подписания) — до этого статус не задаётся.
 */
export type StageStatus =
  | 'waiting_gate'
  | 'in_progress'
  | 'submitted'
  | 'under_acceptance'
  | 'accepted'
  | 'dispute'
  | 'suspended'
  | 'paid';

export interface MilestoneNode {
  id: string;
  parent_id: string | null;
  title: string;
  kind: MilestoneKind;
  /** Сумма только у листьев; у веток вычисляется. */
  amount: MoneyLike | null;
  depth: number;
  checklist_items: ChecklistItem[];
  materials: ContractMaterial[];
  /** Исполнение листа (§6.3) — только на исполняемых договорах (DEV-06), у веток не задаётся. */
  status?: StageStatus;
  /** Короткая подпись под названием листа (напр. «срок до 12 августа») — DEV-06 StageTree. */
  meta?: string;
  /** Срок этапа в днях (DEV-09 §4.2) — только у листьев; срок договора = Σ по листьям. */
  duration_days?: number | null;
  /** Аванс/после приёмки по этапу (DEV-09 §4.4) — оплата вне платформы, авто-пересчёт на клиенте. */
  payment?: MilestonePayment;
  /** Условия этапа переопределяют общие (DEV-09 §2, «заданное на этапе приоритетнее общего»). */
  terms_override?: Partial<ContractTerms>;
}

/** 4 сценария конструктора нейтрального каталога (catalog-v2.md) — «Аренда» в форме делится на вещи/жильё. */
export type ContractKind = 'service' | 'sale' | 'rent_items' | 'rent_home' | 'loan';

/** `GET /v1/contract-types` (ADR-094) — тип клиентского дерева каталога;
 * `code` уходит в `POST /contracts.contract_type_code`, `name` локализован сервером. */
export interface ContractTypeOption {
  code: string;
  name: string;
  client_option: 'service' | 'sale' | 'rent' | 'loan';
}

/** Сфера работ (DEV-09 §3, SpherePicker) — популярные + полный список по поиску. */
export interface Sphere {
  code: string;
  name: string;
  popular?: boolean;
}

/** Тип работ внутри сферы — сужает рекомендации чек-листа (DEV-09 §3/§7). */
export interface WorkType {
  code: string;
  name: string;
  sphere_code: string;
}

/** Тип работ, совпавший с поиском `GET /spheres?q=` (ADR-100) — вместе
 * с именем сферы: выбор одним нажатием задаёт и сферу, и вид работ. */
export interface WorkTypeHit extends WorkType {
  sphere_name: string;
}

/** Ответ `GET /spheres[?q=]` (ADR-091/097/100). */
export interface SphereSearchResponse {
  results: Sphere[];
  popular: Sphere[];
  /** Только при `q`; без запроса — `[]` (ADR-100). */
  work_types?: WorkTypeHit[];
}

/** Позиция каталога материалов (DEV-09 §4.3, MaterialsModal). */
export interface MaterialCatalogItem {
  ref: string;
  title: string;
  default_unit?: string;
}

/** Единица измерения материала (DEV-09 §4.3, UnitPicker) — с подсказкой-примером. */
export interface UnitOption {
  code: string;
  label: string;
  hint?: string;
}

/**
 * Общие условия договора («Условия», DEV-09 §2) — каждое поле предзаполнено дефолтом
 * (⭐ §0). Этап может переопределить любое поле через `MilestoneNode.terms_override`.
 */
export interface ContractTerms {
  warranty_months: number | null;
  acceptance_window_days: number;
  subcontract: 'forbidden' | 'with_consent' | 'allowed';
  premises_access: boolean;
  portfolio_consent: boolean;
}

/** Аванс/после приёмки по этапу (DEV-09 §4.4) — сумма фиксирована, `post` всегда вычисляется. */
export interface MilestonePayment {
  advance: MoneyLike | null;
  advance_percent: number | null;
}

/**
 * Реквизиты стороны (DEV-global-1, DEV-09 §5) — опционально, свёрнуто по умолчанию,
 * без валидации нац. форматов; уходит в `ContractDetail.party_details` (тело/превью/
 * экспорт), не в профиль/поиск/логи.
 */
export interface PartyDetails {
  open: boolean;
  mode: 'personal' | 'business';
  fields: Record<string, string>;
}

export type RevisionAuthorRole = 'customer' | 'contractor';
/**
 * DEV-10 §2 — добавлены `countered` (закрыта встречной редакцией) и `withdrawn`
 * (отозвана автором); терминальны для самой правки, договор при этом остаётся
 * в `under_review` (итерации без тайм-аутов, ADR-009).
 */
export type RevisionStatus = 'open' | 'accepted' | 'rejected' | 'countered' | 'withdrawn';
/** DEV-10 §2 — три точки входа одного протокола: предложение / встречная / предодобренная. */
export type RevisionKind = 'proposal' | 'counter' | 'preapproved';

/** DEV-10 §2 ⭐ — один вариант «стало»; правка/предодобренная несёт 1..N штук. */
export interface RevisionVariant {
  id: string;
  value: string;
  note?: string;
}

export interface RevisionProposal {
  id: string;
  author_role: RevisionAuthorRole;
  /** Ссылка на пункт: «milestone:<id>» / «material:<id>» / «term:total» и т.п. */
  item_ref: string;
  item_label: string;
  before: string;
  /**
   * «Стало» для однозначных правок/обратной совместимости с Ф2 (ContractDetailPage
   * NegoPanel) — всегда равно `variants[0].value`, поддерживается синхронно с ним.
   */
  after: string;
  /** DEV-10 §2 ⭐ — 1..N вариантов «стало»; приём = выбор одного (`VariantPicker`). */
  variants: RevisionVariant[];
  comment: string;
  status: RevisionStatus;
  /** Финансово значимая правка → «принять все» требует confirm_summary (§8.5). */
  financially_material: boolean;
  /** Предложение / встречная редакция / предодобренная (DEV-10 §2). */
  kind: RevisionKind;
  /** Какой вариант выбран — заполняется при `status: 'accepted'`. */
  chosen_variant_id?: string;
  created_at: string;
}

export interface PreapprovedAlternative {
  id: string;
  item_ref: string;
  item_label: string;
  before: string;
  after: string;
  /** DEV-10 §2 — те же варианты, что и у правки; приём в 1 клик, без новой итерации. */
  variants: RevisionVariant[];
}

/** Замороженная версия: snapshot + integrity_hash + TSA (§8.5). */
export interface AiSummaryItem {
  label: string;
  value: string;
}

/**
 * Рендер текста договора на определённом языке (DEV-16b, Л.1). `kind: 'human'` — язык
 * официального текста как есть (совпадает с official_language, не перевод); `'machine'` —
 * автоперевод для удобства чтения (не подписывается). `body` — сам текст; `ref` — ссылка
 * на файл/эндпоинт, если тело слишком большое отдавать инлайн (мок использует только `body`).
 */
export interface ContractRender {
  lang: string;
  kind: 'human' | 'machine';
  body?: string;
  ref?: string;
}

export interface ContractVersion {
  id: string;
  integrity_hash: string;
  tsa_time: string;
  ai_summary: string;
  /** Структурированное резюме для AiSummaryCard (DEV-05 §2) — что делаем/сроки/сумма/расчёт/приёмка. */
  ai_summary_items: AiSummaryItem[];
  snapshot_total: MoneyLike;
  created_at: string;
  /**
   * Язык договора (DEV-16b, Л.1) — «канон» не звучит в UI, только «официальный текст».
   * `official_language` — 'en' по умолчанию (мастер не спрашивает, ГВ.5/Л.1).
   * `is_cross_language` — единственный переключатель языкового слоя экрана подписания:
   * `false` → чистый экран (стороны на одном языке); `true` → бейдж «автоперевод» +
   * тихая строка «Официальный текст — English · показать».
   * `viewer_render` — рендер на языке ТЕКУЩЕГО пользователя (по Accept-Language,
   * подобран бэкендом/моком, не фронтом); отсутствует → фронт показывает `official_render`
   * + тихую подсказку «перевод пока недоступен» (не блокер).
   * `official_render` — официальный текст, всегда `lang === official_language`.
   */
  official_language: string;
  is_cross_language: boolean;
  viewer_render?: ContractRender;
  official_render: ContractRender;
}

export interface SignatureRecord {
  role: RevisionAuthorRole;
  signatory_name: string;
  signed_at: string;
  integrity_hash: string;
}

export type TimelineKind =
  | 'created'
  | 'negotiation.sent'
  | 'revision.proposed'
  | 'revision.accepted'
  | 'revision.rejected'
  | 'revision.countered'
  | 'revision.withdrawn'
  | 'preapproved.applied'
  | 'frozen'
  | 'signature.requested'
  | 'signed.partial'
  | 'contract.signed'
  | 'contract.fee_charged'
  | 'stage.paid'
  | 'declined_for_revision'
  | 'rejected'
  | 'withdrawn';

export interface TimelineEvent {
  id: string;
  at: string;
  kind: TimelineKind;
  actor_role: RevisionAuthorRole | 'system';
  text: string;
}

export interface Signatory {
  id: string;
  display_name: string;
  role: RevisionAuthorRole;
  /** Лимит суммы права подписи (SigningAuthority); null — без лимита. */
  limit: MoneyLike | null;
}

export interface PayoutAccount {
  id: string;
  kind: 'sbp' | 'card' | 'account';
  masked: string;
}


export type ContractFeeStatus = 'pending' | 'charged' | 'failed';

/** Допник — сводка для AmendmentsBlock (DEV-06 §3); карточка допника — вне скоупа (§12). */
export interface AmendmentSummary {
  id: string;
  title: string;
  status: NegotiationStatus;
  amount_delta: MoneyLike | null;
  created_at: string;
}

/** Одна ролевая проекция карточки «Требует внимания» (DEV-06 §2/§8) — симметрия: событие одно, слова разные. */
export interface AttentionRoleView {
  title: string;
  primary?: { label: string; route: 'accept' | 'pay' | 'remind' | 'create-amendment' | 'terminate' | 'warranty-claim' | 'chat' };
  info?: { text: string; note?: string; secondaryLabel?: string; secondaryRoute?: 'remind' | 'chat' };
}

export type ContractAttentionKind = 'accept_milestone' | 'await_acceptance' | 'suspended_materials' | 'await_payment';

/** «Требует внимания сейчас» на карточке договора (DEV-06 §2/§5) — обе роли получают один и тот же event. */
export interface ContractAttention {
  kind: ContractAttentionKind;
  milestone_id?: string;
  deadline?: string;
  views: { customer: AttentionRoleView; contractor: AttentionRoleView };
}

export interface ContractDetail {
  id: string;
  title: string;
  /** Номер договора для шапки (DEV-06 §3 ContractHeader) — короткий человекочитаемый идентификатор. */
  no?: string;
  body_kind: 'template' | 'custom';
  /**
   * Своя редакция текста стороны (DEV-16b §3/§9) — существует только при `body_kind ===
   * 'custom'`. НЕ переводится платформой (в отличие от `version.viewer_render`) —
   * помечается «текст стороны» на экране подписания, оригинал показывается как есть.
   */
  custom_terms?: { author_lang: string; text: string };
  status: NegotiationStatus;
  /** Исполнение после подписания (§6.2) — null/undefined, пока договор не начал исполняться (DEV-06). */
  execution?: ExecutionStatus | null;
  segment: ContractSegment;
  sphere: string;
  contract_type: string;
  tax_note: string | null;
  protection_level: ProtectionLevel;
  parties: ContractSummary['parties'];
  initiator_role: RevisionAuthorRole;
  total: MoneyLike;
  /** Способ расчёта для шапки/MoneyPanel (DEV-06) — не путать с protection_level (лестница защиты). */
  payment_method?: DashboardPaymentMethod;
  milestones: MilestoneNode[];
  revisions: RevisionProposal[];
  preapproved_alternatives: PreapprovedAlternative[];
  version: ContractVersion | null;
  signatures: SignatureRecord[];
  contract_fee: { status: ContractFeeStatus; amount: MoneyLike } | null;
  /** Денежная политика юрисдикции (DEV-05-PATCH, ADR-032) — единственный источник для money-компонентов подписания. */
  payment_policy: PaymentPolicy;
  ai_summary_shown: boolean;
  payout_account_id: string | null;
  timeline: TimelineEvent[];
  /** Допники — AmendmentsBlock (DEV-06 §3); пусто на договорах без допников. */
  amendments?: AmendmentSummary[];
  /** Сроки исполнения — «Обзор» (DEV-06 §5); только на исполняемых договорах. */
  dates?: { start?: string; finish?: string; nearest?: string | null };
  /** Гарантия — отдельная метрика (ADR-030), не пересчитывает рейтинг. */
  warranty_until?: string | null;
  /** Расторжение (ADR-028) — заказчик всегда, исполнитель через окно оспаривания основания. */
  termination?: { by: RevisionAuthorRole; reason?: string; settlement_amount?: MoneyLike | null } | null;
  /** Ролевая карточка внимания на исполняемом договоре (DEV-06 §2/§8) — симметрия событий. */
  attention?: ContractAttention | null;
  /** Сценарий конструктора (DEV-09 §1/§6) — сужает шаг «Суть» до нужной формы полей. */
  contract_kind?: ContractKind;
  /** Тип работ внутри сферы (только `service`) — сужает рекомендации чек-листа. */
  work_type?: string;
  /** Поля формы по типу (DEV-09 §6) — продажа/аренда/займ; тело/превью/экспорт, без отдельной типизации на клиенте. */
  form_data?: Record<string, unknown>;
  /** Реквизиты сторон (DEV-global-1) — опционально, по роли; не влияет на профиль/поиск. */
  party_details?: Partial<Record<RevisionAuthorRole, PartyDetails>>;
  /** Общие условия («Условия», DEV-09 §2) — предзаполнены дефолтами при создании черновика. */
  terms?: ContractTerms;
  created_at: string;
  updated_at: string;
}
