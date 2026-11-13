/**
 * Реальный контур сделки (apps.contracts/apps.milestones) — docs/adr/
 * ADR-088-contracts-execution-flow-real-contract.md, Фаза 1 (docs/tasks/
 * Промт_contracts-phase1-read-create.md). НЕ путать со старым `ContractDetail`
 * (contract-types.ts) — тот мок-агрегат, ещё используется страницами вне
 * этой фазы (ContractReviewPage/SigningPage/StagePage/AcceptancePage,
 * ADR-088 фазы 3–6). Типы здесь — 1:1 с реальными DRF-сериализаторами
 * (`backend/apps/contracts/api/serializers.py`, `apps/milestones/api/
 * serializers.py`), не с продуктовым мок-контрактом.
 */
import type { MoneyLike } from '../money';
import type { NegotiationStatus } from '../fsm';
import type { ContractRole, ProfileKind } from './types';

export type { NegotiationStatus, ContractRole };

/** `Contract.ExecutionStatus` — НЕ совпадает со старым фронтовым `ExecutionStatus`
 * (fsm.ts: нет `pending_start`/`closed`, `warranty` не разбит на under_warranty/
 * warranty_claim) — тот мок-контракт, этот реальный. */
export type RealExecutionStatus =
  | 'pending_start'
  | 'in_progress'
  | 'terminated_by_customer'
  | 'terminated_by_contractor'
  | 'completed'
  | 'warranty'
  | 'closed';

export interface RealContractParty {
  id: string;
  role: ContractRole;
  profile_id: string;
  entity_id: string | null;
  acting_as: ProfileKind;
}

export interface RealContractWarning {
  field: string;
  code: string;
  message: string;
}

/** `apps.contracts.api.serializers.ContractSerializer` — 1:1, включая Фазу 0
 * (`total`/`initiator_role`, ADR-088). */
export interface RealContract {
  id: string;
  contract_type_code: string;
  deal_type: 'b2b' | 'b2c' | 'c2c';
  segment: string;
  negotiation_status: NegotiationStatus;
  execution_status: RealExecutionStatus | null;
  /** СПОСОБ расчёта — как перемещаются деньги. `prepayment` упразднён
   * (ADR-155 §9, владелец 03.09): это был СРОК, а не способ, и он живёт в
   * `payment_order`. */
  payment_method: 'direct_platform' | 'hold' | 'cash' | 'external' | null;
  /** ADR-151: порядок оплаты этапа (срок относительно исполнения) — отдельная
   * ось от `payment_method`; `null` — не выбран или неприменим (заём). */
  payment_order: 'before_start' | 'after_acceptance' | null;
  protected: boolean;
  uses_platform_template: boolean;
  jurisdiction: string;
  title: string;
  form_data: Record<string, unknown>;
  /** ADR-123: дополнительные условия, принятые через правку «Другое»
   * (`item_ref: "other"`); часть текста договора перед подписанием. */
  additional_terms: string[];
  warnings: RealContractWarning[];
  language: string;
  parties: RealContractParty[];
  /** `null` — черновик без ни одного этапа (Фаза 0, `total_leaf_amount`). */
  total: MoneyLike | null;
  /** `null` — оборонительный случай, в норме недостижим (Фаза 0). */
  initiator_role: ContractRole | null;
  /** id ТЕКУЩЕЙ заморозки; `null` — черновик или после decline_for_revision
   * (бэк снимает `frozen_version`). Заменяет раскопки timeline-события
   * `negotiation.frozen` (SigningPage, ADR-088). */
  frozen_version_id: string | null;
  created_at: string;
  /** ADR-158: когда МОЯ сторона в последний раз отмечала материалы этапов
   * просмотренными (`null` — ни разу). Чужую отметку бэк не отдаёт. От неё
   * считается бейдж «Материалы изменены контрагентом»: она переживает смену
   * устройства, в отличие от прежней отметки в `localStorage`. */
  materials_seen_at: string | null;
}

export type RealMilestoneStatus =
  | 'pending'
  | 'in_progress'
  | 'suspended'
  | 'under_acceptance'
  | 'accepted'
  | 'disputed'
  | 'paid';

/** `apps.milestones.selectors.build_tree` — сырой dict-эндпоинт
 * (`GET /contracts/{id}/milestones`), НЕ ModelSerializer — дерево через
 * ВЛОЖЕННЫЙ `children`, не флэт-список с `parent_id` (в отличие от старого
 * мок-контракта `MilestoneNode`). `is_leaf` — уже посчитан бэкендом (не
 * нужно гадать branch/leaf по наличию children, как для мок-типа). */
export interface RealMilestoneTreeNode {
  id: string;
  parent_id: string | null;
  order: number;
  title: string;
  status: RealMilestoneStatus;
  is_leaf: boolean;
  amount: string | null;
  currency: string | null;
  sphere_code: string | null;
  deadline: string | null;
  depends_on_id: string | null;
  frozen_days: number | null;
  submitted_at: string | null;
  accepted_at: string | null;
  children: RealMilestoneTreeNode[];
}

/** `apps.milestones.api.serializers.ChecklistItemSerializer`. `required_evidence` —
 * список ТИПОВ доказательств, не булев флаг (`ChecklistItem.required_evidence`,
 * `models.JSONField(default=list)`) — «фото», «чек» и т.п.; пункт без единого
 * элемента считается необязательным на фронте (ADR-088 Фаза 5, «ничего не требуем»). */
export interface RealChecklistItem {
  id: string;
  milestone_id: string;
  description: string;
  measurable_criterion: string;
  required_evidence: string[];
  order: number;
  created_at: string;
}

/** Кто поставляет материал (`ContractMaterial.Source`, ADR-047): у исполнителя
 * цена обязательна и > 0, у заказчика может быть 0. */
export type RealMaterialSource = 'customer' | 'contractor';

/** От какого события считается срок поставки (`ContractMaterial.DeliveryBase`) —
 * срок в договоре относительный, не абсолютная дата (ADR-047). */
export type RealMaterialDeliveryBase = 'contract_signing' | 'prepayment' | 'stage_start';

/** `apps.milestones.api.serializers.ContractMaterialSerializer`.
 * `catalog_item_code` создания — код позиции каталога из `GET /material-catalog`
 * (поле `ref`), включая обязательную позицию «Прочее» сферы (`other_<sphere>`). */
export interface RealContractMaterial {
  id: string;
  milestone_id: string;
  catalog_item_id: string;
  catalog_item_code: string;
  description: string;
  external_url: string | null;
  quantity: string | null;
  unit: string | null;
  unit_price: string;
  unit_price_currency: string;
  source: RealMaterialSource;
  delivery_days: number | null;
  delivery_base: RealMaterialDeliveryBase | null;
  /** ADR-155: «передано» — заявление стороны-ИСТОЧНИКА (`source`). Гейт этим
   * шагом не двигается и порядок между шагами не обязателен: получение можно
   * отметить и без «передано» (владелец 03.09). */
  handed_over_at: string | null;
  handed_over_by_id: string | null;
  /** «Получено» — подтверждение ДРУГОЙ стороны; ровно этот шаг двигает гейт. */
  received: boolean;
  received_at: string | null;
  received_by_id: string | null;
  created_at: string;
}

/** `POST /v1/milestones/{id}/materials` — `ContractMaterialCreateSerializer`.
 * `unit_price` + `unit_price_currency` — ПАРА (валюты по умолчанию нет);
 * `unit_price` строкой, как все деньги в API. */
export interface RealContractMaterialCreateInput {
  catalog_item_code: string;
  description: string;
  source: RealMaterialSource;
  unit_price: string;
  unit_price_currency: string;
  external_url?: string;
  quantity?: string;
  unit?: string;
  delivery_days?: number;
  delivery_base?: RealMaterialDeliveryBase;
}

/** `PATCH /v1/materials/{id}` — правка материала до подписания (409
 * `contract_immutable` после), все поля опциональны. ЖДЁТ БЭКЕНДА:
 * `apps.milestones` пока отдаёт только `GET/POST /milestones/{id}/materials`,
 * плоские PATCH/DELETE материала делаются по образцу `/checklist-items/{id}`
 * (мок MSW их уже отвечает). */
export type RealContractMaterialPatchInput = Partial<Omit<RealContractMaterialCreateInput, 'catalog_item_code'>> & {
  catalog_item_code?: string;
};

/** `apps.milestones.api.serializers.MilestoneSerializer` — плоский ресурс
 * `GET/PATCH /milestones/{id}` (ADR-088 Фаза 5), НЕ узел дерева
 * (`RealMilestoneTreeNode`, из `/contracts/{id}/milestones` — тот без
 * `contract_id`/`started_at`/подтверждений оплаты). */
export interface RealMilestone {
  id: string;
  contract_id: string;
  parent_id: string | null;
  order: number;
  title: string;
  status: RealMilestoneStatus;
  amount: string | null;
  amount_currency: string | null;
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
  /** ADR-164: id пунктов чек-листа, которые просят фото и его не получили.
   * ПОДСКАЗКА, а не запрет: сдачу этапа они не блокируют (жёсткий гейт снят
   * решением владельца 05.09). Исполнителю — мягкое предупреждение в диалоге
   * «Сдать этап», заказчику — пометка у пункта при приёмке. */
  uncovered_required_evidence: string[];
}

/** `apps.milestones.services._financial_condition` — причина невыполненного
 * финансового условия гейта (`null`, если условие выполнено).
 * `payment_not_confirmed` — предоплата (`payment_order=before_start`): счёт по
 * листу ещё не подтверждён обеими сторонами (ADR-155 §1). Прежний
 * `advance_not_confirmed` исчез вместе со способом `prepayment` (ADR-155 §9). */
export type RealMilestoneGateReason = 'payment_not_confirmed' | 'awaiting_payment' | 'payment_method_not_set';

/** ADR-155 §5: состояние КАЖДОГО условия гейта. `waiting` — ждём,
 * `met` — готово, `not_required` — условия нет вовсе. Булево `met/not met`
 * этого не выражало: «ждём» и «не требуется» рисовались одинаково. */
export type RealGateConditionState = 'waiting' | 'met' | 'not_required';

/** `GET /milestones/{id}/gate` — сырой dict (`services.gate_status`), вне
 * таблицы tech-spec.md §8.5 — видимость причины блокировки ДО `POST .../start`
 * (ADR-088 Фаза 5). Булевы поля остались рядом с `conditions` (ADR-155 §5:
 * «фронт мигрирует без слома»), но состояние строки берём из `conditions`:
 * до подписания там все три `waiting` — решение владельца 03.09. */
export interface RealMilestoneGateStatus {
  signed: boolean;
  materials_ready: boolean;
  financial_condition_met: boolean;
  financial_condition_reason: RealMilestoneGateReason | null;
  conditions: {
    signed: RealGateConditionState;
    materials: RealGateConditionState;
    financial: RealGateConditionState;
  };
  can_start: boolean;
}

/** `POST /milestones/{id}/submit` — `MilestoneSubmitSerializer`. */
export interface RealMilestoneSubmitInput {
  comment?: string;
}

/** `GET /milestones/{id}/acceptance` (tech-spec.md §8.5, `selectors.
 * acceptance_window_status`) — «дедлайн, факт размещения в ЛК, часов
 * осталось». `deadline_at`/`placed_in_cabinet` — юрканал уведомлений
 * (CLAUDE.md: тайм-ауты считаются от размещения в ЛК, не от сдачи). */
export interface RealMilestoneAcceptanceStatus {
  placed_in_cabinet: boolean;
  deadline_at: string | null;
  hours_left: number | null;
}

/** `POST /milestones/{id}/reject` — `MilestoneRejectSerializer` (приёмка,
 * ADR-088 Фаза 6 — тип заведён для полноты соседства с submit, само
 * действие подключается в следующей фазе, не здесь). */
export interface RealMilestoneRejectInput {
  checklist_item_id?: string | null;
  evidence: string[];
}

/** `POST /milestones/{id}/confirm-payment` (унаследованный путь; парного
 * `confirm-advance` больше нет — ADR-155 §9) —
 * `ConfirmSideSerializer{side}`: сторона подтверждает только СВОЮ роль
 * (`WrongConfirmationSideError` → 403 на чужой), значение НЕ выбирается
 * пользователем — вычисляется из `contract.parties` по актёру. */
export interface RealMilestoneConfirmSideInput {
  side: ContractRole;
}

export type RealEvidenceStorageMode = 'ru' | 'global';
export type RealEvidenceDeliveryStatus = 'in_transit' | 'delivered';
export type RealEvidenceBackupStatus = 'not_requested' | 'pending' | 'completed' | 'failed';

/** `apps.evidence.api.serializers.EvidenceSerializer` — 1:1 (ГВ.3, ADR-088
 * Фаза 5). Оригинал НЕ отдаётся этим ресурсом — байты через отдельные
 * `GET /evidence/{id}/thumbnail|download` (бинарный ответ, `responseType:
 * 'blob'` на клиенте). */
export interface RealEvidence {
  id: string;
  contract_id: string;
  milestone_id: string | null;
  checklist_item_id: string | null;
  dispute_id: string | null;
  uploaded_by_id: string;
  file_name: string;
  /** Пояснение автора, данное ПРИ ЗАГРУЗКЕ; менять его нечем (PATCH нет).
   *  Пустая строка — описания не давали. */
  description: string;
  mime_type: string;
  file_size: number;
  file_hash: string;
  trusted_timestamp_at: string;
  trusted_timestamp_source: string;
  has_thumbnail: boolean;
  metadata: Record<string, unknown>;
  storage_mode: RealEvidenceStorageMode;
  delivery_status: RealEvidenceDeliveryStatus;
  delivered_to_counterparty_at: string | null;
  backup_status: RealEvidenceBackupStatus;
  backup_provider: string;
  backup_completed_at: string | null;
  backup_failure_reason: string;
  backup_drive_file_id: string;
  backup_drive_web_view_link: string;
  created_at: string;
}

/** `apps.contracts.models.RevisionProposal.Status` — НЕ совпадает со старым
 * мок-`RevisionStatus` (тот держит отдельные `countered`/`withdrawn`; реальный
 * бэк — `open/accepted/rejected/superseded`, встречное предложение — НОВАЯ
 * запись, не смена статуса старой, ADR-088 «RevisionProposal.variants»). */
export type RealRevisionStatus = 'open' | 'accepted' | 'rejected' | 'superseded';

/** `apps.contracts.api.serializers.RevisionProposalSerializer` — 1:1. Один
 * `old_value`/`new_value` на запись (не список вариантов, ADR-088). */
export interface RealRevisionProposal {
  id: string;
  contract_id: string;
  item_ref: string;
  old_value: unknown;
  new_value: unknown;
  comment: string;
  proposed_by_id: string;
  status: RealRevisionStatus;
  decided_by_id: string | null;
  decided_at: string | null;
  preapproved_alternative_of_id: string | null;
  created_at: string;
}

/** `apps.contracts.api.serializers.PreapprovedAlternativeSerializer`. */
export interface RealPreapprovedAlternative {
  id: string;
  contract_id: string;
  item_ref: string;
  payload: unknown;
  created_by_id: string;
  created_at: string;
}

export type RealSignatureRequestStatus = 'pending' | 'signed' | 'forwarded' | 'declined_for_revision' | 'expired';

/** `apps.contracts.api.serializers.SignatureRequestSerializer`. */
export interface RealSignatureRequest {
  id: string;
  contract_id: string;
  amendment_id: string | null;
  version_id: string;
  side: ContractRole;
  routed_by_id: string;
  signatory_id: string;
  status: RealSignatureRequestStatus;
  sent_at: string;
  expires_at: string | null;
  comment: string;
  locale: string;
  /** Момент подписи по заявке (`status='signed'`); у более старых ответов
   * бэка поля может не быть — тогда время берётся из `Signature.signed_at`. */
  signed_at?: string | null;
}

/** `apps.contracts.api.serializers.TimelineEventSerializer` (outbox-based) —
 * НЕ совпадает со старым мок-`TimelineEvent` (`id/at/kind/actor_role/text`) —
 * реальные поля другие, `text` вообще нет (только сырой `payload`). */
export interface RealTimelineEvent {
  event_id: string;
  topic: string;
  /** ADR-134: стабильный ключ представления события (`contract.signed`,
   * `milestone.accepted`…). У старого бэка отсутствует — фронт берёт
   * `kind ?? topic`, различать события по `payload` НЕ пытается. */
  kind?: string;
  /** ADR-134: событие ДОЧЕРНЕЙ сущности (этап, допник, спор, платёж,
   * гарантийная претензия) — в хронике договора сворачивается группой. */
  nested?: boolean;
  /** ADR-134: локализованная подпись (по языку пользователя) и короткое
   * пояснение — приходят С БЭКА, словарь `kind → текст` на фронте не ведётся
   * (решение владельца 26.08). `title` нет только у старого бэка. */
  title?: string | null;
  detail?: string | null;
  occurred_at: string;
  actor: unknown;
  subject: RealTimelineSubject;
  payload: unknown;
}

/** `subject` элемента хроники (ADR-134): тип и id сущности — по ним фронт
 * строит ссылку («Этап», «Допсоглашение», «Спор»…); `title` — человеческое
 * имя сущности (название этапа), может отсутствовать. */
export interface RealTimelineSubject {
  type: string;
  id: string;
  title?: string | null;
}

/** `renders` — `{lang: {language,hash,document}}` (ADR-088: структурно близко
 * к старому фронтовому `ContractRender[]`; `is_cross_language` — тривиально
 * `Object.keys(renders).length > 1`, derive на клиенте). */
export interface RealContractRender {
  language: string;
  hash: string;
  document: unknown;
}

/** `apps.contracts.api.serializers.ContractVersionSerializer` — снимок на
 * заморозку (`POST /contracts/{id}/freeze`), ETag = `integrity_hash`. Нет
 * `ai_summary`/`ai_summary_items` (ADR-088: фичи на бэке вообще нет, Tier B). */
export interface RealContractVersion {
  id: string;
  contract_id: string;
  snapshot: unknown;
  integrity_hash: string;
  hash_algorithm: string;
  frozen_at: string;
  trusted_timestamp_source: string | null;
  trusted_timestamp_at: string | null;
  official_language: string;
  renders: Record<string, RealContractRender>;
}

/** `apps.contracts.api.serializers.SignatoryOptionSerializer` —
 * `GET /contracts/{id}/signatories?side=`. Р1 БЕЗ `apps.authority`
 * (SigningAuthority не смёржен): для business-стороны список ВСЕГДА пуст —
 * подписание от business-профиля пока физически заблокировано на бэке
 * (не наша фикс-зона, честно показываем в UI, ADR-088 Фаза 4). */
export interface RealSignatoryOption {
  user_id: string;
  basis: string;
}

/** `apps.contracts.api.serializers.SignatureSerializer` — результат
 * `POST /signature-requests/{id}/sign`. */
export interface RealSignature {
  id: string;
  contract_id: string;
  amendment_id: string | null;
  version_hash: string;
  side: ContractRole;
  signatory_id: string;
  signed_at: string;
  signature_basis: string;
}

/** Собранный на клиенте вид договора (ADR-088, решение 1 — композиция, не
 * рефакторинг потребляющих компонентов на россыпь хуков). Один REST-ресурс
 * на поле, не один агрегатный ответ бэка. */
export interface RealContractView {
  contract: RealContract;
  milestones: RealMilestoneTreeNode[];
  revisions: RealRevisionProposal[];
  preapprovedAlternatives: RealPreapprovedAlternative[];
  signatureRequests: RealSignatureRequest[];
  timeline: RealTimelineEvent[];
}

/** `POST /v1/contracts` — `ContractCreateSerializer`. НЕ путать со старым
 * мок-only `CreateDraftFromSourceInput` (contract-types.ts) — тот в паре
 * полей пересекается (`source_contract_id`), но большинство полей другие. */
export interface RealContractCreateInput {
  client_option?: string;
  contract_type_code?: string;
  my_role: ContractRole;
  my_acting_as: ProfileKind;
  my_entity_id?: string;
  counterparty_profile_id?: string;
  counterparty_handle?: string;
  payment_method?: RealContract['payment_method'];
  payment_order?: RealContract['payment_order'];
  title?: string;
  form_data?: Record<string, unknown>;
  jurisdiction?: string;
  source_contract_id?: string;
}

/** `PATCH /v1/contracts/{id}` — `ContractPatchSerializer`. `my_role` СЮДА НЕ
 * ВХОДИТ — фиксируется один раз при создании (ADR-088, «стык»: конфликтует
 * с текущим порядком шагов мастера, где роль выбирается ПОСЛЕ создания
 * черновика). */
export interface RealContractPatchInput {
  client_option?: string;
  contract_type_code?: string;
  my_acting_as?: ProfileKind;
  my_entity_id?: string;
  counterparty_profile_id?: string;
  counterparty_handle?: string;
  payment_method?: RealContract['payment_method'];
  payment_order?: RealContract['payment_order'];
  title?: string;
  form_data?: Record<string, unknown>;
  /** ADR-167: дополнительные условия — список ЦЕЛИКОМ (бэк заменяет, а не
   * дописывает); каждый пункт непуст после trim, ≤2000 символов, ≤20 пунктов
   * (400 `additional_terms_invalid`). Только на черновике: после отправки
   * PATCH отвечает 409 `draft_not_editable`. */
  additional_terms?: string[];
  language?: string;
}

/** `POST /v1/contracts/{id}/milestones` — `MilestoneCreateSerializer`. */
export interface RealMilestoneCreateInput {
  title: string;
  parent_id?: string;
  order?: number;
  amount?: string;
  currency?: string;
  sphere_code?: string;
  deadline?: string;
  depends_on_id?: string;
}

/** `PATCH /v1/milestones/{id}` — `MilestonePatchSerializer`. */
export interface RealMilestonePatchInput {
  title?: string;
  order?: number;
  amount?: string;
  currency?: string;
  sphere_code?: string;
  deadline?: string;
}

/** `POST /v1/milestones/{id}/checklist-items` — `ChecklistItemCreateSerializer`. */
export interface RealChecklistItemCreateInput {
  description: string;
  measurable_criterion: string;
  required_evidence?: string[];
  order?: number;
}

/** `PATCH /v1/checklist-items/{id}` — `ChecklistItemPatchSerializer`: все поля
 * опциональны, отсутствующее — «не менять» (как у `RealMilestonePatchInput`).
 * Только до подписания (409 `contract_immutable` после). */
export interface RealChecklistItemPatchInput {
  description?: string;
  measurable_criterion?: string;
  required_evidence?: string[];
  order?: number;
}

/** `POST /v1/contracts/{id}/signature-requests` — `SignatureRequestCreateSerializer`.
 * `version_id` адресует ИМЕННО ТЕКУЩУЮ заморозку (защита от «устарело», как
 * `version_hash` на `sign` — 409 `version_stale`, если не совпадает). */
export interface RealSignatureRequestCreateInput {
  side: ContractRole;
  version_id: string;
  signatory_user_id: string;
  comment?: string;
}

/** `POST /v1/signature-requests/{id}/sign` — `SignRequestSerializer`. `esign` —
 * задел под УНЭП/Госключ (JurisdictionConfig), Р1 принимает, но не валидирует. */
export interface RealSignInput {
  version_hash: string;
  esign?: Record<string, unknown>;
}

/** `POST /v1/signature-requests/{id}/forward` — `ForwardSignatureRequestSerializer`. */
export interface RealForwardSignatureRequestInput {
  comment?: string;
}

/** `POST /v1/signature-requests/{id}/decline` — `DeclineForRevisionSerializer`. */
export interface RealDeclineSignatureRequestInput {
  comment: string;
}

// --- Допники Э4.5 (tech-spec.md §8.6, ADR-131 §3) ---------------------------
//
// Допник (`Amendment`) — самостоятельный документ к уже ПОДПИСАННОМУ договору,
// идёт по ТОЙ ЖЕ FSM согласования (`NegotiationStatus`) и подписывается тем
// же контуром `signature-requests` (`SignatureRequest.amendment_id` не пуст).
// Подпись — на `integrity_hash` замороженной версии допника (та же таблица
// `ContractVersion`, что у договора, — `GET /contracts/{id}/versions/{vid}`).

/** `apps.contracts.models.AmendmentChange.Type`. */
export type RealAmendmentChangeType =
  | 'add_milestone'
  | 'modify_milestone'
  | 'remove_milestone'
  | 'add_material'
  | 'modify_material'
  | 'remove_material'
  | 'custom_term';

/** `AmendmentChangeSerializer` — 1:1. `payload` — сырой JSON изменения
 * (`amount`/`currency`/`deadline`/`title` у этапа, `unit_price`/
 * `unit_price_currency`/`quantity` у материала, `text` у прочего условия,
 * `anti_waiver` у скидки по спору — ADR-131 §3); дельты считает СЕРВЕР при
 * создании допника, клиент их не присылает. `amount_delta`/
 * `amount_delta_currency` — money-пара, оба `null` вместе. */
export interface RealAmendmentChange {
  id: string;
  type: RealAmendmentChangeType;
  target: string | null;
  payload: Record<string, unknown>;
  amount_delta: string | null;
  amount_delta_currency: string | null;
  days_delta: number;
  created_at: string;
}

/** `AmendmentSerializer` — 1:1. `amount_delta`/`days_delta` — суммарные по
 * всем `changes` (`compute_amendment_deltas`, тот же расчёт, что в
 * замороженном снимке). `frozen_version_id` — `null` до заморозки и после
 * возврата на доработку. */
export interface RealAmendment {
  id: string;
  contract_id: string;
  order: number;
  reason: string;
  custom_terms: string;
  negotiation_status: NegotiationStatus;
  frozen_version_id: string | null;
  created_by_id: string;
  created_at: string;
  changes: RealAmendmentChange[];
  amount_delta: MoneyLike | null;
  days_delta: number;
}

/** Тело `POST /v1/amendments/{id}/withdraw` (инициатор) и
 * `POST /v1/amendments/{id}/reject` (вторая сторона): причина необязательна,
 * уходит в payload события `amendment.withdrawn`/`amendment.rejected`. */
export interface RealAmendmentCloseInput {
  reason?: string;
}

/** `POST /v1/contracts/{id}/amendments` — `AmendmentCreateSerializer`. */
export interface RealAmendmentCreateInput {
  reason: string;
  changes: { type: RealAmendmentChangeType; target?: string | null; payload?: Record<string, unknown> }[];
  custom_terms?: string;
}

/** Одно изменение в теле создания/правки допника — `changes[]` целиком
 * пересобирается на каждой отправке (ADR-161 §2), точечных операций нет. */
export interface RealAmendmentChangeInput {
  type: RealAmendmentChangeType;
  target?: string | null;
  payload?: Record<string, unknown>;
}

/** `PATCH /v1/amendments/{id}` — `AmendmentUpdateSerializer` (ADR-161 §2).
 * Тело равно телу создания: `changes` заменяется ЦЕЛИКОМ, потому что дельты
 * и гейты считает сервер от текущего дерева, а не от diff'а. Доступен только
 * при `negotiation_status: 'draft'` и только инициатору: не инициатор — 403
 * `not_initiator`, отправленный допник — 409 `amendment_not_draft`. */
export type RealAmendmentUpdateInput = RealAmendmentCreateInput;

/** `GET /v1/contracts/{id}/effective-terms` — `services.effective_terms`:
 * базовый замороженный снимок договора (поля снимка — как есть) + список
 * ПРИМЕНЁННЫХ (`signed`) допников + ЖИВАЯ сумма по листьям. */
export interface RealEffectiveTerms {
  amendments: {
    order: number;
    reason: string;
    custom_terms: string;
    amount_delta: MoneyLike | null;
    days_delta: number;
  }[];
  total_amount: MoneyLike | null;
  [snapshotField: string]: unknown;
}

// --- Платёжный контур Э5, волна 1 (ADR-130) -------------------------------
//
// `apps.payments` — ИСТОЧНИК ПРАВДЫ о деньгах; отметки
// `Milestone.paid_confirmed_*_at` остались
// денормализованным зеркалом (его пишет только `apps.payments.services`),
// поэтому фронт читает состояние оплаты ИЗ `Payment`, а не из узла этапа.
// Платформа денег не проводит (финмодель v2, док 28): «оплата» — это
// двустороннее подтверждение факта, а не эквайринг.

/** `apps.payments.models.Payment.Kind`. В этой волне выставляется ЕДИНСТВЕННЫЙ
 * вид — `postpayment` («оплата этапа»); КОГДА его платят, решает
 * `Contract.payment_order`, а не вид (ADR-155 §2). Вид `advance` упразднён
 * вместе со способом `prepayment`; `prepayment` (ЧАСТИЧНАЯ предоплата) и
 * `refund` зарезервированы схемой §5.2.6 и не создаются — но перечислены,
 * чтобы неизвестное значение не ломало типизацию, когда партнёр появится. */
export type RealPaymentKind = 'postpayment' | 'prepayment' | 'refund';

/** `Payment.method` — СНИМОК способа расчёта договора на момент выставления
 * (договор может измениться допником, выставленный счёт — нет). */
export type RealPaymentMethod = 'cash' | 'external' | 'direct_platform' | 'hold';

/** `Payment.Status`. Достижимы в этой волне только первые пять
 * (`PAYMENT_FSM`, ADR-130 §3); остальные — «провайдерская эра», объявлены
 * бэком сразу и недостижимы по построению. Просрочка НЕ статус: платёж
 * остаётся `pending`, меняется только `overdue_at`. */
export type RealPaymentStatus =
  | 'pending'
  | 'payer_confirmed'
  | 'payee_confirmed'
  | 'confirmed'
  | 'cancelled'
  | 'processing'
  | 'held'
  | 'captured'
  | 'voided'
  | 'refunded'
  | 'disputed'
  | 'failed'
  | 'observed';

/** Сторона денег: плательщик — заказчик, получатель — исполнитель
 * (`apps.payments.services.PAYER_ROLE`/`PAYEE_ROLE`). Считается НА БЭКЕ и
 * приезжает готовым (`my_side`) — фронт доменное правило не повторяет. */
export type RealPaymentSide = 'payer' | 'payee';

/** `GET /v1/payments/{id}`, элемент `GET /v1/contracts/{id}/payments`
 * (`apps.payments.api.serializers.PaymentSerializer`).
 *
 * `amount` — СТРОКА (CLAUDE.md: деньги в API строкой). `my_side`/
 * `confirmed_by_me` зависят от ЗРИТЕЛЯ: `null` у того, кто не сторона. */
export interface RealPayment {
  id: string;
  contract_id: string;
  milestone_id: string;
  milestone_title: string;
  kind: RealPaymentKind;
  method: RealPaymentMethod;
  status: RealPaymentStatus;
  amount: string;
  currency: string;
  confirmed_by_payer: boolean;
  confirmed_by_payee: boolean;
  payer_confirmed_at: string | null;
  payee_confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  /** Момент, когда СРОК ОПЛАТЫ вышел (свип `apps.deadlines`, категория
   * `payment_settlement`, 14 суток от выставления). Не статус — платёж
   * по-прежнему подлежит оплате. */
  overdue_at: string | null;
  provider: string;
  provider_ref: string | null;
  my_side: RealPaymentSide | null;
  confirmed_by_me: boolean | null;
  created_at: string;
}

/** `GET /v1/contracts/{id}/payments` — обёртка `{items}` (в отличие от
 * `GET /contracts/{id}/milestones`, отдающего голый массив). */
export interface RealPaymentListResponse {
  items: RealPayment[];
}

/** `POST /v1/payments/{id}/confirm` — `PaymentConfirmSerializer`. `side`
 * НЕОБЯЗАТЕЛЕН: бэк выводит сторону из роли вызывающего и лишь сверяет
 * переданное значение (403 `wrong_confirmation_side` при расхождении) —
 * подтвердить «за контрагента» нельзя даже с правильным телом. */
export interface RealPaymentConfirmInput {
  side?: RealPaymentSide;
}

/** `POST /v1/payments/{id}/cancel` — `PaymentCancelSerializer`. Отмена
 * возможна ТОЛЬКО из `pending` и любой стороной: счёт — техническая
 * запись «к оплате», а не односторонняя претензия. */
export interface RealPaymentCancelInput {
  reason?: string;
}
