import { formatMoney, type MoneyLike } from '@porukam/core';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './SectionHeader.module.css';

export interface SectionHeaderProps {
  title: string;
  /** Сумма раздела — вычисляется (сумма вложенных этапов), у раздела своих денег нет. */
  amount: MoneyLike;
  onDelete?: () => void;
  deleteAria: string;
}

/** Заголовок раздела конструктора «Этапы» (DEV-09 §4.1) — группирует этапы, сумма вычисляется. */
export function SectionHeader({ title, amount, onDelete, deleteAria }: SectionHeaderProps): JSX.Element {
  return (
    <div className={styles.row} data-testid="section-header">
      <Icon name="stages" size={20} className={styles.icon} />
      <span className={styles.title}>{title}</span>
      <LtrText as="span" className={styles.amount}>{formatMoney(amount)}</LtrText>
      {onDelete ? (
        <button type="button" className={styles.remove} onClick={onDelete} aria-label={deleteAria}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
}
