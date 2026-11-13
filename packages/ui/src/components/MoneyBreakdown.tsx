import { formatMoney, type MoneyLike } from '@porukam/core';
import { LtrText } from './LtrText';
import styles from './MoneyBreakdown.module.css';

export interface BreakdownRow {
  label: string;
  money: MoneyLike;
  muted?: boolean;
}

export interface MoneyBreakdownProps {
  rows: BreakdownRow[];
  total?: { label: string; money: MoneyLike };
  caption?: string;
}

/**
 * Раскладка суммы — показывается ДО действия (§9.4): «база → комиссия → к получению».
 * Все суммы — через общий formatMoney (строка+валюта).
 */
export function MoneyBreakdown({ rows, total, caption }: MoneyBreakdownProps): JSX.Element {
  return (
    <div className={styles.box}>
      {rows.map((r, i) => (
        <div className={`${styles.row} ${r.muted ? styles.muted : ''}`} key={i}>
          <span className={styles.label}>{r.label}</span>
          <LtrText as="span" className={styles.value}>{formatMoney(r.money)}</LtrText>
        </div>
      ))}
      {total ? (
        <div className={`${styles.row} ${styles.total}`}>
          <span className={styles.label}>{total.label}</span>
          <LtrText as="span" className={styles.value}>{formatMoney(total.money)}</LtrText>
        </div>
      ) : null}
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </div>
  );
}
