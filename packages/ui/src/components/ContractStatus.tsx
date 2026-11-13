import type { ContractCardStatus } from '@porukam/core';
import { Badge, type BadgeTone } from './Badge';
import { StatusWord } from './StatusWord';
import styles from './ContractStatus.module.css';

export const STATUS_TONE: Record<ContractCardStatus, BadgeTone> = {
  draft: 'neutral',
  under_review: 'amber',
  rejected_by_counterparty: 'red',
  withdrawn_by_initiator: 'neutral',
  pending_signature: 'amber',
  awaiting_signatures: 'amber',
  signed: 'green',
  // Канон чипов (эталон №1 блок 6): «В работе» — amber; teal зарезервирован
  // за защитой платежа/гарантией, не за ходом работ (DEV-17).
  in_progress: 'amber',
  suspended: 'amber',
  completed: 'green',
  terminated_by_customer: 'red',
  terminated_by_contractor: 'red',
  under_warranty: 'teal',
  warranty_claim: 'amber',
};

export interface ContractStatusProps {
  status: ContractCardStatus;
  /** Уже переведённый текст статуса — страница берёт его из i18n (§12: смысл не только цветом). */
  label: string;
  /** «Этап N из M» — опционально, только для in_progress/suspended (DEV-06 §3). */
  stageCaption?: string;
  /** Подложка чипа — на паспорт-рейле карточки она тёмная (DEV-19 §4). */
  on?: 'light' | 'dark';
  /** `sm` — компактный чип строки списка (DEV-20 §2). */
  size?: 'sm' | 'md';
  /**
   * `chip` — заливка+точка (шапки, паспорт-рейл); `word` — статус СЛОВОМ-цветом
   * без подложки (строка списка, DEV-20_2 §2). Тон один и тот же — `STATUS_TONE`
   * остаётся единственной картой статус→цвет.
   */
  appearance?: 'chip' | 'word';
}

/** Единый статус-чип договора (DEV-06 §3/§4) — ОДИН статус, текст+цвет, не два поля рядом. */
export function ContractStatus({
  status,
  label,
  stageCaption,
  on = 'light',
  size = 'md',
  appearance = 'chip',
}: ContractStatusProps): JSX.Element {
  const tone = STATUS_TONE[status];
  return (
    <span className={styles.wrap} data-testid="contract-status" data-status={status}>
      {appearance === 'word' ? (
        <StatusWord label={label} tone={tone} />
      ) : (
        <Badge tone={tone} dot on={on} size={size}>
          {label}
        </Badge>
      )}
      {stageCaption ? (
        <span className={on === 'dark' ? `${styles.caption} ${styles.captionOnDark}` : styles.caption}>{stageCaption}</span>
      ) : null}
    </span>
  );
}
