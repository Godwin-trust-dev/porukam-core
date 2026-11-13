/**
 * Контур разногласий и гарантии (этап 7 бэкенда, ADR-131) — зеркало
 * `apps.disputes.api.serializers` и `apps.warranty.api.serializers` 1:1.
 *
 * Отдельный файл, а не строки в `types.ts`: контур большой (спор + раунды
 * исправления + скидка-допник + окна оспаривания + гарантийная претензия) и
 * живёт своей жизнью — так же, как `real-contract-types.ts` и
 * `payment-types.ts` отделены от общего среза.
 *
 * Деньги — ВСЕГДА пара «строка + валюта» (CLAUDE.md: суммы в API строкой,
 * валюты по умолчанию нет нигде): `new_amount`/`new_amount_currency` не
 * сводятся к одному полю и не парсятся в number.
 */
import type { ContractRole } from './types';

/** `Dispute.Kind` — разногласие по ЭТАПУ либо ГАРАНТИЙНОЕ (ADR-131 §7:
 * у гарантийного нет ни этапа, ни пункта чек-листа — претензия к результату
 * договора целиком). */
export type DisputeKind = 'milestone' | 'warranty';

/** `Dispute.Status` — FSM ADR-131 §1. `resolved` — терминальное. */
export type DisputeStatus = 'open' | 'awaiting_fix' | 'awaiting_discount' | 'resolved';

/** Грубая классификация исхода из tech-spec.md §5.2.7 (`Dispute.outcome`);
 * детальный код — `resolution_type`. Два поля, а не одно (ADR-131 §6). */
export type DisputeOutcome = 'resolved' | 'cap_reached' | 'escalated_to_court';

/**
 * Детальный код исхода. Через API принимаются ТОЛЬКО пять (см.
 * `DisputeResolveSerializer`): `discount_accepted` ставит подписанный допник,
 * `cap_reached` — свип потолка 30 дней; кнопки для них нет.
 */
export type DisputeApiResolutionType =
  | 'accepted'
  | 'withdrawn'
  | 'escalated_to_court'
  | 'warranty_satisfied'
  | 'warranty_declined';

export type DisputeResolutionType = DisputeApiResolutionType | 'discount_accepted' | 'cap_reached';

/** `{profile_id, display_name, role}` ВТОРОЙ стороны относительно читателя
 * (ADR-131 §9). `display_name: null` — согласие профиля `show_name=false`,
 * а не ошибка; `null` целиком — сторона не найдена. */
export interface DisputeCounterparty {
  profile_id: string;
  display_name: string | null;
  role: ContractRole;
  /** ADR-173: фото контрагента — лид строки раздела «Споры». `null` — фото
   * нет либо зрителю нельзя (deals_only, ADR-103). */
  avatar_url: string | null;
}

/**
 * Раунд исправления — ПАРА действий: заказчик просит (`requested_at`),
 * исполнитель сдаёт (`resubmitted_at`). Максимум два раунда
 * (`409 fix_rounds_exhausted`).
 */
export interface FixRequest {
  id: string;
  /** 1 или 2 (БД-инвариант `fix_request_round_within_cap`). */
  round: number;
  requested_by_id: string;
  comment: string;
  requested_at: string;
  resubmitted_by_id: string | null;
  resubmit_comment: string;
  resubmitted_at: string | null;
}

export type DiscountAgreementStatus = 'proposed' | 'accepted' | 'declined';

/**
 * Скидка = ДОПНИК (ADR-131 §3): `amendment_id` — вход в общий контур
 * подписания §8.6. Отдельной кнопки «принять скидку» НЕТ — принятие это
 * подпись допника; в контуре спора есть только `decline`.
 */
export interface DiscountAgreement {
  id: string;
  amendment_id: string;
  milestone_id: string;
  proposed_by_id: string;
  old_amount: string;
  old_amount_currency: string;
  new_amount: string;
  new_amount_currency: string;
  /** §20.3: «скидка закрывает только указанный дефект» — юрзначимый текст
   * стороны, дефолта у него нет. */
  anti_waiver_note: string;
  status: DiscountAgreementStatus;
  decided_by_id: string | null;
  decided_at: string | null;
  created_at: string;
}

export type DisputeWindowKind = 'dispute_response' | 'termination_notice';

/**
 * Окно оспаривания (ADR-019/ADR-131 §4). `contested`: `true` — оспорено,
 * `false` — истекло молча (факт зафиксирован, НЕ санкция), `null` — окно
 * ещё идёт ЛИБО снято досрочно (тогда `closed_at` заполнен).
 * `deadline_at: null` — уведомление ещё не размещено в ЛК, окно не тикает
 * (ADR-057).
 */
export interface DisputeWindow {
  id: string;
  kind: DisputeWindowKind;
  contract_id: string;
  dispute_id: string | null;
  subject_ref: { type?: string; id?: string };
  opened_at: string;
  deadline_at: string | null;
  contested: boolean | null;
  contested_by_id: string | null;
  contested_at: string | null;
  closed_at: string | null;
}

/**
 * Реплика стороны (`DisputeReplySerializer`, `POST /disputes/{id}/respond`):
 * своя строка, а не поиск по outbox — карточка спора показывает, ЧТО
 * ответила сторона, не только факт «окно оспорено». Статус спора реплика
 * не меняет. `evidence` — id доказательств, как у `Dispute.evidence`.
 */
export interface DisputeReply {
  id: string;
  author_id: string;
  comment: string;
  evidence: string[];
  created_at: string;
}

/**
 * `GET /v1/disputes` и `GET /v1/disputes/{id}` — ОДИН сериализатор
 * (`DisputeSerializer`), поэтому один тип: список уже несёт вложенные
 * раунды, скидки и окна, второй запрос за карточкой не нужен.
 */
export interface Dispute {
  id: string;
  kind: DisputeKind;
  /** `null` у гарантийного разногласия — этапа там нет. */
  milestone_id: string | null;
  contract_id: string;
  checklist_item_id: string | null;
  opened_by_id: string;
  counterparty: DisputeCounterparty | null;
  evidence: string[];
  status: DisputeStatus;
  fix_rounds_used: number;
  /** `MAX_FIX_ROUNDS - fix_rounds_used`, не отрицательный. */
  fix_rounds_left: number;
  resolution_type: DisputeResolutionType | '' | null;
  outcome: DisputeOutcome | '' | null;
  opened_at: string;
  /** Потолок 30 дней (ADR-020); `null` — спор из данных до ADR-131. */
  cap_deadline_at: string | null;
  /** `null` — потолок неизвестен ЛИБО спор уже закрыт. */
  days_to_cap: number | null;
  resolved_at: string | null;
  fix_requests: FixRequest[];
  discount_agreements: DiscountAgreement[];
  windows: DisputeWindow[];
  /** Реплики сторон по порядку `created_at`; у ответов бэка до этого поля —
   * может отсутствовать. */
  replies?: DisputeReply[];
}

/**
 * `awaiting_confirmation` — исполнитель сообщил об устранении, претензия
 * ждёт ПОДТВЕРЖДЕНИЯ заказчика (ADR-133: подтверждает заказчик, симметрично
 * отказу исполнителя; молчание в окне = автоподтверждение по свипу).
 */
export type WarrantyClaimStatus = 'submitted' | 'awaiting_confirmation' | 'resolved';

/**
 * `WarrantyFixSerializer` — цикл «устранил -> подтвердил / не устранено»:
 * исполнитель сдаёт («устранил»), заказчик либо подтверждает (`satisfy`),
 * либо возражает (`contest`, `contested_*`). Потолок — на ВОЗРАЖЕНИЯ
 * заказчика (`fix_rounds_used`, `MAX_FIX_ROUNDS` как у спора по этапу;
 * третье — `409 fix_rounds_exhausted`), не на сдачи исполнителя.
 */
export interface WarrantyFix {
  id: string;
  round: number;
  submitted_by_id: string;
  comment: string;
  evidence: string[];
  submitted_at: string;
  contested_by_id: string | null;
  contest_comment: string;
  contest_evidence: string[];
  contested_at: string | null;
}

/**
 * Гарантийная претензия (`apps.warranty`, ADR-030: своя метрика, рейтинг
 * задним числом не пересчитывается). `dispute_id` — разногласие, в котором
 * идёт диалог: карточка спора открывается по нему.
 */
export interface WarrantyClaim {
  id: string;
  contract_id: string;
  submitted_by_id: string;
  description: string;
  evidence: string[];
  status: WarrantyClaimStatus;
  /** `warranty_satisfied` / `warranty_declined` / `warranty_auto_satisfied`
   * (свип окна подтверждения) — как в `Dispute.resolution_type`. */
  resolution_type: string;
  dispute_id: string | null;
  submitted_at: string;
  resolved_at: string | null;
  /** Устранения по претензии (ADR-133); у ответов бэка до этого контура — нет. */
  fixes?: WarrantyFix[];
  /** Число возражений «не устранено» заказчика; `fix_rounds_left` —
   * `MAX_FIX_ROUNDS - fix_rounds_used`, не отрицательный. */
  fix_rounds_used?: number;
  fix_rounds_left?: number;
  fix_submitted_at?: string | null;
  /** Дедлайн окна подтверждения заказчика (`DomainDeadline` kind
   * `warranty_claim_acceptance`, той же длины, что окно приёмки этапа) —
   * только в `awaiting_confirmation`; `null` — уведомление ещё не размещено
   * в ЛК, окно не тикает (ADR-057). В `GET /dispute-windows` этого окна НЕТ
   * — виджет дашборда собирает его из претензий. */
  acceptance_deadline_at?: string | null;
}

/** Тело `POST /v1/disputes/{id}/discount-proposal`. */
export interface DiscountProposalInput {
  new_amount: string;
  currency: string;
  anti_waiver_note: string;
  reason: string;
}

/** Тело `POST /v1/contracts/{id}/warranty-claims` (доказательство обязательно
 * — `allow_empty=False` на бэке). */
export interface WarrantyClaimInput {
  description: string;
  evidence: string[];
}

/** Тело `POST /v1/warranty-claims/{id}/decline` — отказ исполнителя. */
export interface WarrantyClaimDeclineInput {
  comment?: string;
}

/** Тело `POST /v1/warranty-claims/{id}/fix-submitted` — исполнитель
 * сообщает об устранении (ADR-133). */
export interface WarrantyFixSubmittedInput {
  comment?: string;
  evidence?: string[];
}

/** Тело `POST /v1/warranty-claims/{id}/satisfy` — заказчик подтверждает
 * устранение (из любого незакрытого статуса — «сделали на месте» тоже). */
export interface WarrantySatisfyInput {
  comment?: string;
}

/** Тело `POST /v1/warranty-claims/{id}/contest` — заказчик: «не
 * устранено» (только в `awaiting_confirmation`; комментарий обязателен). */
export interface WarrantyContestInput {
  comment: string;
  evidence?: string[];
}
