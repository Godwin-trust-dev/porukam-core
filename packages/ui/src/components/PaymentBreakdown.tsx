import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './PaymentBreakdown.module.css';

export interface PaymentBreakdownProps {
  /** «Вы переводите» — считает страница. */
  payingLabel: string;
  /** Уже отформатированная сумма (formatPolicyMoney + paymentPolicy.currency) — без хардкода валюты. */
  amountLabel: string;
  /** Строка из `paymentPolicy.transferFee` — «Комиссия платформы — нет» / «с комиссией», по политике. */
  transferTitle: string;
  transferNote?: string;
  positive: boolean;
  /** Честная оговорка про возможный тариф банка/провайдера — БЕЗ суммы (DEV-07 §2). */
  caveat?: string;
}

/**
 * Прозрачная раскладка платежа до действия (DEV-07 §2/§3) — «Вы переводите X» +
 * позиция платформы по комиссии (из политики) + честная оговорка без сумм.
 * Никаких литералов денег/валюты — только переданные готовые строки.
 */
export function PaymentBreakdown({
  payingLabel,
  amountLabel,
  transferTitle,
  transferNote,
  positive,
  caveat,
}: PaymentBreakdownProps): JSX.Element {
  return (
    <div className={styles.box} data-testid="payment-breakdown">
      <div className={styles.headline}>
        <span className={styles.payingLabel}>{payingLabel}</span>
        <LtrText as="span" className={styles.amount}>{amountLabel}</LtrText>
      </div>
      <div className={styles.transferRow} data-tone={positive ? 'positive' : 'neutral'}>
        <Icon name={positive ? 'pay-protected' : 'wallet'} size={20} className={styles.transferIcon} />
        <div>
          <p className={styles.transferTitle}>{transferTitle}</p>
          {transferNote ? <p className={styles.transferNote}>{transferNote}</p> : null}
        </div>
      </div>
      {caveat ? <p className={styles.caveat}>{caveat}</p> : null}
    </div>
  );
}
