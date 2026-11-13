import { Button } from './Button';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './FeePaymentSbp.module.css';

export interface FeePaymentSbpProps {
  title: string;
  /** Уже отформатированная сумма (через `formatPolicyMoney` + `paymentPolicy.currency`) — считает страница. */
  amountLabel: string;
  contractNo: string;
  contractNoLabel: string;
  steps: string[];
  nonRefundableNote: string;
  payLabel: string;
  onPay: () => void;
  loading?: boolean;
  qrHint: string;
}

/**
 * Оплата комиссии по СБП (DEV-05 §3; DEV-05-PATCH: сумма — готовая строка от
 * страницы, без своей денежной логики) — QR-плейсхолдер + шаги + невозвратность.
 */
export function FeePaymentSbp({
  title,
  amountLabel,
  contractNo,
  contractNoLabel,
  steps,
  nonRefundableNote,
  payLabel,
  onPay,
  loading,
  qrHint,
}: FeePaymentSbpProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.amount}>
        <LtrText as="span">{amountLabel}</LtrText>
      </p>
      <p className={styles.contractNo}>
        {contractNoLabel}: {contractNo}
      </p>

      <div className={styles.qr} role="img" aria-label={qrHint}>
        <Icon name="wallet" size={48} className={styles.qrIcon} />
      </div>

      <ol className={styles.steps}>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>

      <p className={styles.warn}>{nonRefundableNote}</p>

      <Button variant="primary" block onClick={onPay} loading={loading} data-testid="pay-fee">
        {payLabel}
      </Button>
    </div>
  );
}
