import { formatMoney, type MoneyLike } from '@porukam/core';
import { Badge, type BadgeTone } from './Badge';
import { LtrText } from './LtrText';
import styles from './ContractRow.module.css';

export type ContractRowPayment = 'cash' | 'bank' | 'sbp';

export interface ContractRowProgress {
  done: number;
  total: number;
}

export interface ContractRowProps {
  title: string;
  counterparty: string;
  progress: ContractRowProgress;
  progressLabel: string;
  /** Короткий гейт-блокер (напр. «Ждёт подписи») — опционален. */
  gate?: string;
  amount: MoneyLike;
  payment: ContractRowPayment;
  paymentLabel: string;
  onOpen?: () => void;
}

const PAYMENT_TONE: Record<ContractRowPayment, BadgeTone> = {
  cash: 'neutral',
  bank: 'ink',
  sbp: 'teal',
};

/**
 * Строка активного договора (DEV-03 §3): тип оплаты (наличный/безналичный/СБП),
 * без статуса «под защитой» (эскроу в MVP нет). Прогресс дублируется текстом.
 */
export function ContractRow({
  title,
  counterparty,
  progress,
  progressLabel,
  gate,
  amount,
  payment,
  paymentLabel,
  onOpen,
}: ContractRowProps): JSX.Element {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const body = (
    <>
      <div className={styles.main}>
        <h4 className={styles.title}>{title}</h4>
        <p className={styles.counterparty}>{counterparty}</p>
        <div className={styles.badges}>
          <Badge tone={PAYMENT_TONE[payment]}>{paymentLabel}</Badge>
          {gate ? <Badge tone="amber">{gate}</Badge> : null}
        </div>
      </div>
      <div className={styles.aside}>
        <LtrText as="span" className={styles.amount}>{formatMoney(amount)}</LtrText>
        <div className={styles.progressBar} aria-hidden="true">
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.progress}>{progressLabel}</span>
      </div>
    </>
  );

  if (onOpen) {
    return (
      <button type="button" className={`${styles.row} ${styles.interactive}`} onClick={onOpen}>
        {body}
      </button>
    );
  }
  return <div className={styles.row}>{body}</div>;
}
