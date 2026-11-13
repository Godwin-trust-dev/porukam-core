/**
 * Человекочитаемый текст ошибки действия по этапу (ADR-164, п. 1 жалобы
 * 05.09).
 *
 * Что было. `apps.milestones.api.views._call_service` кладёт в problem+json
 * `detail=str(exc)` — СЛУЖЕБНЫЙ текст исключения, часто с UUID («этап
 * 01a06217-…: не все required_evidence чек-листа покрыты»). `ApiError.message`
 * по построению берёт `detail || title`, поэтому страница этапа показывала
 * человеку именно его: на любом языке, с идентификатором внутри.
 *
 * Что стало. Читаем КОД ошибки и переводим сами — тот же приём, что у
 * `revisionErrorText` (`contract.revisionError.*`, ADR-157 §2). Незнакомый код
 * — `problem.title` (короткая формулировка бэка, `apiErrorText`), и только
 * если и его нет — общий текст. Служебный `detail` наружу не показываем
 * никогда: он для журнала, не для человека.
 */
import { ApiError } from '@porukam/core';

import { apiErrorText } from '../../shared/apiErrorText';

type TFunction = (key: string, vars?: Record<string, unknown>) => string;

/** Коды `_SERVICE_ERROR_STATUS` из `apps/milestones/api/views.py`, которые
 * достижимы со страницы этапа: гейт старта, сдача, приёмка, отклонение,
 * материалы. `required_evidence_not_covered` в списке НЕТ — ADR-164 снял и
 * гейт, и код. */
const STAGE_ERROR_KEYS: Record<string, string> = {
  gate_not_signed: 'stage.realStartBlockedNotSigned',
  gate_materials_not_ready: 'stage.realStartBlockedMaterials',
  gate_financial_condition_not_met: 'stage.realStartBlockedFinancial',
  gate_not_on_leaf: 'stage.actionError.notOnLeaf',
  invalid_milestone_transition: 'stage.actionError.invalidTransition',
  invalid_transition: 'stage.actionError.invalidTransition',
  checklist_item_required: 'stage.actionError.checklistItemRequired',
  checklist_item_wrong_milestone: 'stage.actionError.checklistItemWrongMilestone',
  evidence_required: 'stage.actionError.evidenceRequired',
  milestone_already_accepted: 'stage.actionError.alreadyAccepted',
  material_handover_wrong_side: 'stage.actionError.materialWrongSide',
  material_already_received: 'stage.actionError.materialAlreadyReceived',
  permission_denied: 'stage.actionError.permissionDenied',
  not_found: 'stage.actionError.notFound',
  rate_limited: 'stage.actionError.rateLimited',
};

/** Причина невыполненного финансового условия гейта (`context.reason` у 409
 * `gate_financial_condition_not_met`, ADR-155 §5) — тот же словарь читает
 * строка условия «Финансовое условие» в карточке этапа. */
export const GATE_REASON_KEY: Record<string, string> = {
  payment_not_confirmed: 'stage.realGateReasonPaymentNotConfirmed',
  awaiting_payment: 'stage.realGateReasonAwaitingPayment',
  payment_method_not_set: 'stage.realGateReasonPaymentMethodNotSet',
};

export function stageErrorText(e: unknown, t: TFunction): string {
  if (!(e instanceof ApiError)) return t('common.unexpectedErrorTitle');
  if (e.code === 'gate_financial_condition_not_met') {
    // У этого отказа причина машиночитаема — она точнее общего текста.
    const reason = (e.problem.context as { reason?: string } | undefined)?.reason;
    const reasonKey = reason ? GATE_REASON_KEY[reason] : undefined;
    if (reasonKey) return t(reasonKey);
  }
  const key = e.code ? STAGE_ERROR_KEYS[e.code] : undefined;
  if (key) return t(key);
  return apiErrorText(e) ?? t('common.unexpectedErrorTitle');
}
