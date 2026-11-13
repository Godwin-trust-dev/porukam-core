import { formatMoney, type MoneyLike } from '@porukam/core';
import { LtrText } from './LtrText';
import styles from './TrustNumber.module.css';

export interface TrustNumberProps {
  count: number;
  volume: MoneyLike;
  /** Год начала — используется только для формирования sinceLabel на странице. */
  since?: number;
  completedLabel: string;
  volumeLabel: string;
  /** Готовая переведённая строка «С {{year}} года» — не показываем, если не задана. */
  sinceLabel?: string;
}

/** Цифра доверия (DEV-01 §2): Onest, tabular-nums, число + объём + год начала. */
export function TrustNumber({ count, volume, completedLabel, volumeLabel, sinceLabel }: TrustNumberProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <div className={styles.count}>{new Intl.NumberFormat('ru-RU').format(count)}</div>
      <div className={styles.completedLabel}>{completedLabel}</div>
      <div className={styles.meta}>
        <span className={styles.volume}>
          <LtrText as="span">{formatMoney(volume)}</LtrText> <span className={styles.volumeLabel}>· {volumeLabel}</span>
        </span>
        {sinceLabel ? <span className={styles.since}>{sinceLabel}</span> : null}
      </div>
    </div>
  );
}
