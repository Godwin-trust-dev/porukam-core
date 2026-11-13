/**
 * Единый статус карточки для РЕАЛЬНОГО контура сделки (ADR-088, Фаза 1) —
 * общая логика для ContractsListPage.tsx и ContractDetailPage.tsx (не
 * дублируем). `RealExecutionStatus` НЕ 1:1 со старым фронтовым
 * `ExecutionStatus` (packages/core/src/fsm.ts): `pending_start` схлопывается
 * в «подписан», `closed` — в «завершён», единый `warranty` — в «на гарантии»
 * (без разбора на «гарантия»/«гарантийный случай», реальный бэк такого
 * различия не делает). «Приостановлен» (по этапу) здесь не вычисляется —
 * потребовал бы тянуть дерево этапов туда, где сейчас есть только список
 * контрактов (известное упрощение Фазы 1, см. отчёт задачи).
 */
import type { ContractCardStatus, RealContract } from '@porukam/core';

export const MUTED_STATUSES: ContractCardStatus[] = [
  'terminated_by_customer',
  'terminated_by_contractor',
  'rejected_by_counterparty',
  'withdrawn_by_initiator',
];

export function realCardStatus(c: RealContract): ContractCardStatus {
  switch (c.execution_status) {
    case null:
    case undefined:
      return c.negotiation_status;
    case 'pending_start':
      return 'signed';
    case 'closed':
      return 'completed';
    case 'warranty':
      return 'under_warranty';
    default:
      return c.execution_status;
  }
}

export type ListBucket = 'active' | 'archive' | 'drafts';

/**
 * Корзина сделки для вкладок `/contracts` и превью дашборда.
 *
 * `openWarrantyClaims` — id договоров, по которым ПРЯМО СЕЙЧАС открыт
 * гарантийный случай (`GET /v1/warranty-claims`, см. `useOpenWarrantyClaims`).
 * Решение владельца 31.08: гарантийный период сам по себе — архив, сделка
 * исполнена и делать по ней нечего; но как только заявка подана, по договору
 * снова идёт работа — он возвращается в «Активные» и уходит обратно в архив,
 * когда заявка закрыта. Реальный бэк отдельного статуса «гарантийный случай»
 * не заводит (`execution_status` — единый `warranty`), поэтому различие
 * приходит списком заявок, а не полем договора.
 */
export function bucketOf(c: RealContract, openWarrantyClaims?: ReadonlySet<string>): ListBucket {
  if (c.negotiation_status === 'draft') return 'drafts';
  if (c.negotiation_status === 'rejected_by_counterparty' || c.negotiation_status === 'withdrawn_by_initiator') return 'archive';
  if (c.execution_status === 'warranty' && openWarrantyClaims?.has(c.id)) return 'active';
  if (c.execution_status && ['completed', 'warranty', 'closed', 'terminated_by_customer', 'terminated_by_contractor'].includes(c.execution_status)) {
    return 'archive';
  }
  return 'active';
}

/**
 * Порядок статусов для сортировки «по статусу» (замечание владельца 31.08:
 * «в архиве всё кучей навалено»). Идём по жизненному пути сделки — от
 * незаконченного согласования к работе, гарантии и терминальным исходам, —
 * чтобы в архиве завершённые не перемешивались с отклонёнными и
 * расторгнутыми, а в активных сначала шло то, что ещё не подписано.
 */
const STATUS_ORDER: ContractCardStatus[] = [
  'draft',
  'under_review',
  'pending_signature',
  'awaiting_signatures',
  'signed',
  'in_progress',
  'suspended',
  'warranty_claim',
  'under_warranty',
  'completed',
  'rejected_by_counterparty',
  'withdrawn_by_initiator',
  'terminated_by_customer',
  'terminated_by_contractor',
];

/** Сравнение по статусу; внутри одного статуса — свежие сверху. */
export function compareByStatus(a: RealContract, b: RealContract): number {
  const rank = (c: RealContract): number => {
    const index = STATUS_ORDER.indexOf(realCardStatus(c));
    // Неизвестный статус (бэк добавил новый) не должен молча уезжать наверх.
    return index === -1 ? STATUS_ORDER.length : index;
  };
  const byStatus = rank(a) - rank(b);
  if (byStatus !== 0) return byStatus;
  return a.created_at < b.created_at ? 1 : -1;
}
