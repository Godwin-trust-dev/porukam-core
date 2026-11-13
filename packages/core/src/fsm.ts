/**
 * Зеркало FSM согласования договора/допника (техспецификация §6.1, ADR-006/009).
 * НЕ истина — для гейтинга кнопок в UI и как контракт мок-слоя. Итоговое
 * решение всегда за бэкендом; недопустимый переход мок отдаёт как
 * 409 invalid_state_transition (как сделал бы Django).
 */
export type NegotiationStatus =
  | 'draft'
  | 'under_review'
  | 'pending_signature'
  | 'awaiting_signatures'
  | 'signed'
  | 'rejected_by_counterparty'
  | 'withdrawn_by_initiator';

/** Разрешённые переходы (§6.1). Правка после pending_signature → under_review. */
export const NEGOTIATION_TRANSITIONS: Record<NegotiationStatus, NegotiationStatus[]> = {
  draft: ['under_review'],
  under_review: [
    'under_review',
    'rejected_by_counterparty',
    'withdrawn_by_initiator',
    'pending_signature',
  ],
  pending_signature: ['awaiting_signatures', 'under_review'],
  awaiting_signatures: ['pending_signature', 'under_review', 'signed'],
  signed: [],
  rejected_by_counterparty: [],
  withdrawn_by_initiator: [],
};

export const TERMINAL_STATUSES: NegotiationStatus[] = [
  'signed',
  'rejected_by_counterparty',
  'withdrawn_by_initiator',
];

export function canTransition(from: NegotiationStatus, to: NegotiationStatus): boolean {
  return NEGOTIATION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: NegotiationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Правки/ревизии допустимы только в under_review (после заморозки — откат). */
export function isEditable(status: NegotiationStatus): boolean {
  return status === 'draft' || status === 'under_review';
}

/**
 * Исполнение договора после подписания (техспецификация §6.2, ADR-028/030).
 * НЕ хранится как отдельная колонка совместно со `status` — это продолжение
 * жизненного цикла ПОСЛЕ `signed` (§6.1 не описывает переходов дальше `signed`).
 * «Приостановлен» сюда не входит — вычисляемый признак (§6.2), см. computeCardStatus.
 */
export type ExecutionStatus =
  | 'in_progress'
  | 'completed'
  | 'under_warranty'
  | 'warranty_claim'
  | 'terminated_by_customer'
  | 'terminated_by_contractor';

export const EXECUTION_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  in_progress: ['completed', 'terminated_by_customer', 'terminated_by_contractor'],
  completed: ['under_warranty'],
  under_warranty: ['warranty_claim'],
  warranty_claim: ['under_warranty'],
  terminated_by_customer: [],
  terminated_by_contractor: [],
};

export const EXECUTION_TERMINAL_STATUSES: ExecutionStatus[] = [
  'terminated_by_customer',
  'terminated_by_contractor',
];

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Единый статус карточки договора (DEV-06 §4): согласование → исполнение,
 * плюс вычисляемый `suspended` (in_progress + хотя бы один этап suspended, §6.2).
 * Показываем ОДИН текущий статус — компонент ContractStatus рендерит его.
 */
export type ContractCardStatus = NegotiationStatus | ExecutionStatus | 'suspended';

export function computeCardStatus(input: {
  status: NegotiationStatus;
  execution?: ExecutionStatus | null;
  hasSuspendedStage?: boolean;
}): ContractCardStatus {
  if (!input.execution) return input.status;
  if (input.execution === 'in_progress' && input.hasSuspendedStage) return 'suspended';
  return input.execution;
}
