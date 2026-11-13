import { ApiError } from '@porukam/core';

/**
 * Коды ошибок контура разногласий (tech-spec.md §8.8, ADR-131) → ключи
 * `dispute`-неймспейса. Показываем текст ПО КОДУ, а не `problem.title`:
 * заголовок бэка приходит на языке запроса и годится как запасной вариант,
 * но у этих семи кодов есть свои объяснения «что делать дальше», которых в
 * одной строке заголовка нет («раунды исчерпаны — дальше скидка, согласие
 * или суд»).
 */
const CODE_KEY: Record<string, string> = {
  fix_rounds_exhausted: 'dispute.errorFixRoundsExhausted',
  fix_request_already_resubmitted: 'dispute.errorFixAlreadyResubmitted',
  dispute_already_resolved: 'dispute.errorAlreadyResolved',
  invalid_dispute_transition: 'dispute.errorInvalidTransition',
  discount_already_decided: 'dispute.errorDiscountAlreadyDecided',
  dispute_window_closed: 'dispute.errorWindowClosed',
  discount_not_applicable: 'dispute.errorDiscountNotApplicable',
  evidence_required: 'dispute.errorEvidenceRequired',
  checklist_item_required: 'dispute.errorChecklistItemRequired',
  warranty_period_not_active: 'dispute.errorWarrantyPeriodNotActive',
  wrong_dispute_side: 'dispute.errorWrongSide',
  not_dispute_counterparty: 'dispute.errorNotCounterparty',
  permission_denied: 'dispute.errorPermissionDenied',
  warranty_claim_already_resolved: 'dispute.errorWarrantyAlreadyResolved',
  warranty_claim_dispute_missing: 'dispute.errorWarrantyDisputeMissing',
  warranty_claim_not_awaiting_confirmation: 'dispute.errorWarrantyNotAwaiting',
  warranty_claim_awaiting_confirmation: 'dispute.errorWarrantyAlreadyAwaiting',
};

/** Ключ перевода для ошибки действия; `null` — код незнакомый (тогда экран
 * покажет `problem.title` бэка либо общий текст). */
export function disputeErrorKey(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  return (err.code ? CODE_KEY[err.code] : undefined) ?? null;
}

export function disputeErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}
