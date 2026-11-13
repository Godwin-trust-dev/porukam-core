import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './CommissionSection.module.css';

export interface CommissionSectionProps {
  title: string;
  /** Уже отформатированная сумма (через `formatPolicyMoney` + `paymentPolicy.currency`) — считает страница. */
  amountLabel: string;
  /** Уже отформатированная подпись процента (i18n, напр. «≈0.85 %») — опциональна. */
  percentLabel?: string;
  paidBy: string;
  paidByLabel: string;
  payAtSigningNote: string;
  /** Показывается только если `paymentPolicy.contractFee.nonRefundable === true`. */
  nonRefundableNote?: string;
}

/**
 * Раздел «Комиссия» — ТОЛЬКО исполнитель-бизнес (DEV-05 §3, ADR-054; DEV-05-PATCH:
 * данные из `paymentPolicy.contractFee`). Компонент не форматирует деньги/проценты
 * сам — принимает готовые подписи, чтобы не хардкодить `%`/валюту (ADR-032).
 */
export function CommissionSection({
  title,
  amountLabel,
  percentLabel,
  paidBy,
  paidByLabel,
  payAtSigningNote,
  nonRefundableNote,
}: CommissionSectionProps): JSX.Element {
  return (
    <div className={styles.card} data-testid="commission-section">
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.amountRow}>
        <LtrText as="span" className={styles.amount}>{amountLabel}</LtrText>
        {percentLabel ? <span className={styles.percent}>{percentLabel}</span> : null}
      </div>
      <p className={styles.row}>
        <span className={styles.label}>{paidByLabel}</span>
        <span className={styles.value}>{paidBy}</span>
      </p>
      <p className={styles.note}>{payAtSigningNote}</p>
      {nonRefundableNote ? (
        <p className={styles.warn}>
          <Icon name="dispute" size={16} className={styles.warnIcon} />
          {nonRefundableNote}
        </p>
      ) : null}
    </div>
  );
}
