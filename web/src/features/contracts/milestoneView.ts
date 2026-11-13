/**
 * Показ дерева этапов «только чтение» — общая правда для облегчённой карточки
 * master-detail (`ContractDetailPane`) и обзора карточки договора
 * (`ContractDetailPage`, DEV-19 §2/§4). Один статус этапа = одна подпись и
 * одна трактовка «принят/сейчас» в обоих местах, а не две похожие карты.
 */
import type { RealMilestoneStatus, RealMilestoneTreeNode } from '@porukam/core';

/** Этап закрыт — teal-галочка в списке. */
export const DONE_MILESTONE_STATUSES: RealMilestoneStatus[] = ['accepted', 'paid'];
/** Этап «сейчас» — янтарный чип. */
export const CURRENT_MILESTONE_STATUSES: RealMilestoneStatus[] = ['in_progress', 'under_acceptance'];

export const MILESTONE_STATUS_KEY: Record<RealMilestoneStatus, string> = {
  pending: 'contract.card.stageStatusWaitingGate',
  in_progress: 'contract.card.stageStatusInProgress',
  suspended: 'contract.card.stageStatusSuspended',
  under_acceptance: 'contract.card.stageStatusUnderAcceptance',
  accepted: 'contract.card.stageStatusAccepted',
  disputed: 'contract.card.stageStatusDispute',
  paid: 'contract.card.stageStatusPaid',
};

/** Принимаются и оплачиваются ЛИСТЬЯ (доменная модель) — ветки только группируют. */
export function leavesOf(nodes: RealMilestoneTreeNode[]): RealMilestoneTreeNode[] {
  return nodes.flatMap((n) => (n.is_leaf ? [n] : leavesOf(n.children)));
}

export function doneCountOf(leaves: RealMilestoneTreeNode[]): number {
  return leaves.filter((m) => DONE_MILESTONE_STATUSES.includes(m.status)).length;
}
